(function () {
    'use strict';

    var WHATSAPP_NUMERO = '527772257877';
    var DB_KEY = 'crefacil_db_v2';
    var DRAFT_KEY = 'crefacil_draft_v2';

    var DEFAULT_MODALIDADES = [
        { id: 'diaria', nombre: 'Pago diario', frecuencia: 'diaria', cadaDias: 1, numeroPagos: 7, interes: 20, omitirDomingo: true },
        { id: 'semanal', nombre: 'Pago semanal', frecuencia: 'semanal', cadaDias: 7, numeroPagos: 4, interes: 25, omitirDomingo: true }
    ];

    var $ = function (sel, root) { return (root || document).querySelector(sel); };
    var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

    var fmtMoney = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 0, maximumFractionDigits: 2 });
    function money(n) { return fmtMoney.format(Number(n) || 0); }
    function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
    function esc(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function pad(n) { return String(n).padStart(2, '0'); }
    function toISO(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
    function parseISO(iso) {
        var p = String(iso || '').split('-').map(Number);
        if (p.length !== 3 || !p[0]) return new Date();
        return new Date(p[0], p[1] - 1, p[2], 12, 0, 0);
    }
    function addDays(date, n) {
        var d = new Date(date.getTime());
        d.setDate(d.getDate() + n);
        return d;
    }
    function todayISO() { return toISO(new Date()); }
    function fmtFecha(iso) {
        if (!iso) return '—';
        return parseISO(iso).toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });
    }
    function fmtFechaLarga(iso) {
        if (!iso) return '—';
        return parseISO(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });
    }
    function normalizeTel(v) {
        var digits = String(v || '').replace(/\D/g, '');
        if (digits.length > 10) digits = digits.slice(-10);
        return digits;
    }
    function fmtTel(v) {
        var d = normalizeTel(v);
        return d.length === 10 ? d.slice(0, 3) + ' ' + d.slice(3, 6) + ' ' + d.slice(6) : (v || '—');
    }
    function uid() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
        return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    /* ---------------- Almacenamiento ---------------- */
    function seedDB() {
        return {
            version: 2,
            creado: new Date().toISOString(),
            modalidades: DEFAULT_MODALIDADES.map(function (m) { return Object.assign({}, m); }),
            clientes: []
        };
    }

    function loadDB() {
        try {
            var raw = localStorage.getItem(DB_KEY);
            if (!raw) return seedDB();
            var data = JSON.parse(raw);
            if (!data || typeof data !== 'object') return seedDB();
            if (!Array.isArray(data.modalidades) || data.modalidades.length === 0) {
                data.modalidades = DEFAULT_MODALIDADES.map(function (m) { return Object.assign({}, m); });
            }
            if (!Array.isArray(data.clientes)) data.clientes = [];
            data.version = 2;
            return data;
        } catch (e) {
            return seedDB();
        }
    }

    function saveDB() {
        try {
            localStorage.setItem(DB_KEY, JSON.stringify(db));
            return true;
        } catch (e) {
            toast('No se pudo guardar. Revisa el espacio de tu navegador.', 'error');
            return false;
        }
    }

    var db = loadDB();
    var editingId = null;
    var currentClientId = null;
    var modalidadEditingId = null;
    var toastTimer = null;
    var draftTimer = null;

    function getModalidad(id) {
        return db.modalidades.filter(function (m) { return m.id === id; })[0];
    }

    /* ---------------- Cálculo de pagos ---------------- */
    function stepDays(mod) {
        if (mod.frecuencia === 'diaria') return 1;
        if (mod.frecuencia === 'semanal') return 7;
        return Math.max(1, parseInt(mod.cadaDias, 10) || 1);
    }

    function buildSchedule(monto, mod, fechaInicio) {
        var montoNum = Number(monto) || 0;
        var total = round2(montoNum * (1 + (Number(mod.interes) || 0) / 100));
        var n = Math.max(1, Math.min(120, parseInt(mod.numeroPagos, 10) || 1));
        var step = stepDays(mod);
        var cur = parseISO(fechaInicio);
        var pagos = [];
        var acumulado = 0;

        for (var i = 1; i <= n; i++) {
            cur = addDays(cur, step);
            if (mod.omitirDomingo) {
                var guard = 0;
                while (cur.getDay() === 0 && guard < 14) {
                    cur = addDays(cur, 1);
                    guard++;
                }
            }
            var montoPago = i === n ? round2(total - acumulado) : round2(total / n);
            acumulado = round2(acumulado + montoPago);
            pagos.push({ n: i, fecha: toISO(cur), monto: montoPago, pagado: false });
        }
        return { total: total, pagos: pagos };
    }

    function clientStats(c) {
        var pagos = Array.isArray(c.pagos) ? c.pagos : [];
        var total = Number(c.total) || pagos.reduce(function (s, p) { return s + (Number(p.monto) || 0); }, 0);
        var pagado = pagos.reduce(function (s, p) { return s + (p.pagado ? (Number(p.monto) || 0) : 0); }, 0);
        var saldo = round2(total - pagado);
        var hoy = todayISO();
        var vencidos = pagos.filter(function (p) { return !p.pagado && p.fecha < hoy; }).length;
        var pagadosCount = pagos.filter(function (p) { return p.pagado; }).length;
        var estado = saldo <= 0.009 ? 'liquidado' : (vencidos > 0 ? 'vencido' : 'pendiente');
        return { total: total, pagado: pagado, saldo: saldo, vencidos: vencidos, pagadosCount: pagadosCount, estado: estado };
    }

    function estadoBadge(estado) {
        if (estado === 'liquidado') return '<span class="badge badge-ok">Liquidado</span>';
        if (estado === 'vencido') return '<span class="badge badge-danger">Vencido</span>';
        return '<span class="badge badge-warn">Pendiente</span>';
    }

    function descripcionMod(m) {
        var cuando = m.frecuencia === 'diaria' ? 'Un pago cada día'
            : m.frecuencia === 'semanal' ? 'Un pago cada semana'
                : 'Un pago cada ' + stepDays(m) + ' días';
        return cuando + ', hasta ' + m.numeroPagos + ' pagos en total.';
    }

    /* ---------------- WhatsApp ---------------- */
    function waLink(text) {
        return 'https://wa.me/' + WHATSAPP_NUMERO + '?text=' + encodeURIComponent(text);
    }

    function mensajeCliente(c) {
        var s = clientStats(c);
        return [
            'Hola CREFÁCIL, registro mi solicitud:',
            'Nombre: ' + c.nombre,
            'WhatsApp: ' + fmtTel(c.telefono),
            'Monto: ' + money(c.monto),
            'Modalidad: ' + c.modalidadNombre + (c.modalidadSnapshot && c.modalidadSnapshot.omitirDomingo ? ' (sin domingos)' : ''),
            'Total a pagar: ' + money(s.total),
            'Pago por cuota: ' + money(c.pagos && c.pagos.length ? c.pagos[0].monto : 0),
            'Primer pago: ' + fmtFechaLarga(c.pagos && c.pagos.length ? c.pagos[0].fecha : ''),
            'Último pago: ' + fmtFechaLarga(c.pagos && c.pagos.length ? c.pagos[c.pagos.length - 1].fecha : ''),
            c.notas ? 'Notas: ' + c.notas : ''
        ].filter(Boolean).join('\n');
    }

    function abrirWhatsApp(c) {
        window.open(waLink(mensajeCliente(c)), '_blank', 'noopener');
    }

    /* ---------------- Render ---------------- */
    function renderModalidadOptions() {
        var select = $('#modalidad');
        if (!select) return;
        var prev = select.value;
        select.innerHTML = db.modalidades.map(function (m) {
            return '<option value="' + esc(m.id) + '">' + esc(m.nombre) + ' · ' + m.numeroPagos + ' pagos' + (m.omitirDomingo ? ' sin domingos' : '') + '</option>';
        }).join('');
        if (prev && getModalidad(prev)) select.value = prev;
    }

    function renderModalidadesGrid() {
        var grid = $('#modalidadesGrid');
        if (!grid) return;
        grid.innerHTML = db.modalidades.map(function (m) {
            return '<article class="modality-card reveal">' +
                '<h3>' + esc(m.nombre) + '</h3>' +
                '<p>' + esc(descripcionMod(m)) + '</p>' +
                '<div class="modality-tags">' +
                '<span class="tag">' + m.numeroPagos + ' pagos</span>' +
                '<span class="tag tag-blue">' + esc(m.interes) + '% interés</span>' +
                (m.omitirDomingo ? '<span class="tag">Sin domingos</span>' : '') +
                '</div>' +
                '<button type="button" class="btn btn-sm btn-outline" data-usar-modalidad="' + esc(m.id) + '">Registrar con esta modalidad</button>' +
                '</article>';
        }).join('');
        observeReveals();
    }

    function renderFiltroModalidad() {
        var sel = $('#filtroModalidad');
        if (!sel) return;
        var prev = sel.value;
        sel.innerHTML = '<option value="">Todas las modalidades</option>' + db.modalidades.map(function (m) {
            return '<option value="' + esc(m.id) + '">' + esc(m.nombre) + '</option>';
        }).join('');
        if (prev) sel.value = prev;
    }

    function renderClientes() {
        var cont = $('#listaClientes');
        if (!cont) return;
        var q = ($('#buscar') && $('#buscar').value || '').trim().toLowerCase();
        var fMod = $('#filtroModalidad') ? $('#filtroModalidad').value : '';
        var fEstado = $('#filtroEstado') ? $('#filtroEstado').value : '';

        var lista = db.clientes.filter(function (c) {
            var s = clientStats(c);
            if (q && String(c.nombre || '').toLowerCase().indexOf(q) === -1 && String(c.telefono || '').indexOf(q) === -1) return false;
            if (fMod && c.modalidadId !== fMod) return false;
            if (fEstado && s.estado !== fEstado) return false;
            return true;
        });

        if (!lista.length) {
            cont.innerHTML = '<div class="empty-state">' + (db.clientes.length ? 'No hay clientes que coincidan con la búsqueda.' : 'Aún no hay clientes registrados.<br>Usa el formulario de registro para agregar el primero.') + '</div>';
            return;
        }

        cont.innerHTML = lista.map(function (c) {
            var s = clientStats(c);
            var pct = s.total > 0 ? Math.min(100, Math.round((s.pagado / s.total) * 100)) : 0;
            return '<article class="cliente-card">' +
                '<div class="cliente-top">' +
                '<div><h3>' + esc(c.nombre) + '</h3><p>' + esc(fmtTel(c.telefono)) + '</p></div>' +
                estadoBadge(s.estado) +
                '</div>' +
                '<div class="cliente-data">' +
                '<span>Monto <b>' + money(c.monto) + '</b></span>' +
                '<span>Saldo <b>' + money(s.saldo) + '</b></span>' +
                '<span>' + esc(c.modalidadNombre || 'Sin modalidad') + '</span>' +
                '</div>' +
                '<div class="progress" aria-label="' + pct + '% pagado"><span style="width:' + pct + '%"></span></div>' +
                '<div class="cliente-foot">' +
                '<button type="button" class="btn btn-sm btn-outline" data-ver-cliente="' + esc(c.id) + '">Ver pagos</button>' +
                '<button type="button" class="btn btn-sm btn-ghost" data-wa-cliente="' + esc(c.id) + '"><svg class="icon icon-fill"><use href="#i-wa"/></svg> WhatsApp</button>' +
                '</div>' +
                '</article>';
        }).join('');
    }

    function renderClienteDetalle(id) {
        var c = db.clientes.filter(function (x) { return x.id === id; })[0];
        if (!c) return;
        currentClientId = id;
        var s = clientStats(c);
        var pct = s.total > 0 ? Math.min(100, Math.round((s.pagado / s.total) * 100)) : 0;
        var hoy = todayISO();

        $('#clienteTitulo').textContent = c.nombre;
        $('#clienteDetalle').innerHTML =
            '<div class="detail-top">' +
            '<span>WhatsApp <b>' + esc(fmtTel(c.telefono)) + '</b></span>' +
            '<span>Modalidad <b>' + esc(c.modalidadNombre || '—') + '</b></span>' +
            '<span>Inicio <b>' + fmtFecha(c.fechaInicio) + '</b></span>' +
            '</div>' +
            '<div class="detail-summary">' +
            '<div><small>Monto</small><strong>' + money(c.monto) + '</strong></div>' +
            '<div><small>Total a pagar</small><strong>' + money(s.total) + '</strong></div>' +
            '<div><small>Pagado</small><strong>' + money(s.pagado) + '</strong></div>' +
            '<div><small>Saldo</small><strong>' + money(s.saldo) + '</strong></div>' +
            '</div>' +
            '<div class="progress"><span style="width:' + pct + '%"></span></div>' +
            '<p class="detail-notes">' + s.pagadosCount + ' de ' + (c.pagos ? c.pagos.length : 0) + ' pagos completados' + (s.vencidos ? ' · ' + s.vencidos + ' vencido(s)' : '') + '</p>' +
            '<table class="schedule"><thead><tr><th>#</th><th>Fecha</th><th>Monto</th><th>Pagado</th></tr></thead><tbody>' +
            (c.pagos || []).map(function (p, i) {
                var vencido = !p.pagado && p.fecha < hoy;
                return '<tr class="' + (p.pagado ? 'done' : '') + '">' +
                    '<td>' + p.n + '</td>' +
                    '<td>' + fmtFecha(p.fecha) + (vencido ? ' <span class="late">Vencido</span>' : '') + '</td>' +
                    '<td>' + money(p.monto) + '</td>' +
                    '<td><input class="pay-check" type="checkbox" data-pay="' + i + '" ' + (p.pagado ? 'checked' : '') + ' aria-label="Pago ' + p.n + '"></td>' +
                    '</tr>';
            }).join('') +
            '</tbody></table>' +
            (c.notas ? '<p class="detail-notes"><b>Notas:</b> ' + esc(c.notas) + '</p>' : '');

        $('#clienteAcciones').innerHTML =
            '<a class="btn btn-wa" href="' + esc(waLink(mensajeCliente(c))) + '" target="_blank" rel="noopener"><svg class="icon icon-fill"><use href="#i-wa"/></svg> WhatsApp</a>' +
            '<button type="button" class="btn btn-outline" data-ver-editar>Editar</button>' +
            '<button type="button" class="btn btn-ghost btn-danger" data-ver-eliminar>Eliminar</button>';
    }

    function renderListaModalidades() {
        var cont = $('#listaModalidades');
        if (!cont) return;
        cont.innerHTML = db.modalidades.map(function (m) {
            var usos = db.clientes.filter(function (c) { return c.modalidadId === m.id; }).length;
            return '<div class="modality-row">' +
                '<div class="m-info"><strong>' + esc(m.nombre) + '</strong><small>' +
                esc(descripcionMod(m)) + ' · ' + esc(m.interes) + '% · ' + (m.omitirDomingo ? 'sin domingos' : 'incluye domingos') +
                ' · ' + usos + ' cliente(s)</small></div>' +
                '<button type="button" class="icon-btn" data-edit-mod="' + esc(m.id) + '" aria-label="Editar ' + esc(m.nombre) + '"><svg class="icon"><use href="#i-edit"/></svg></button>' +
                '<button type="button" class="icon-btn" data-del-mod="' + esc(m.id) + '" aria-label="Eliminar ' + esc(m.nombre) + '"><svg class="icon"><use href="#i-trash"/></svg></button>' +
                '</div>';
        }).join('');
    }

    function renderAll() {
        renderModalidadOptions();
        renderModalidadesGrid();
        renderFiltroModalidad();
        renderClientes();
    }

    /* ---------------- Vista previa ---------------- */
    function previewData() {
        var monto = Number($('#monto').value);
        var mod = getModalidad($('#modalidad').value);
        var fecha = $('#fechaInicio').value;
        if (!monto || !mod || !fecha) return null;
        var calc = buildSchedule(monto, mod, fecha);
        return { monto: monto, mod: mod, total: calc.total, pagos: calc.pagos };
    }

    function updatePreview() {
        var el = $('#preview');
        if (!el) return;
        var data = previewData();
        if (!data || !data.pagos.length) {
            el.innerHTML = '<div class="pv-note">Completa monto, modalidad y fecha para ver tu calendario de pagos.</div>';
            return;
        }
        var ultimo = data.pagos[data.pagos.length - 1];
        var primero = data.pagos[0];
        el.innerHTML =
            '<div class="pv-item"><div class="pv-label">Total a pagar</div><div class="pv-value green">' + money(data.total) + '</div></div>' +
            '<div class="pv-item"><div class="pv-label">Pago por cuota</div><div class="pv-value">' + money(primero.monto) + '</div></div>' +
            '<div class="pv-item"><div class="pv-label">Número de pagos</div><div class="pv-value">' + data.pagos.length + '</div></div>' +
            '<div class="pv-item"><div class="pv-label">Primer pago</div><div class="pv-value">' + fmtFecha(primero.fecha) + '</div></div>' +
            '<div class="pv-item"><div class="pv-label">Último pago</div><div class="pv-value">' + fmtFecha(ultimo.fecha) + '</div></div>' +
            '<div class="pv-note">' + (data.mod.omitirDomingo
                ? 'Los domingos no se generan pagos: si una fecha cae en domingo, se recorre al lunes.'
                : 'Esta modalidad incluye pagos en domingo si la fecha corresponde.') + '</div>';
    }

    /* ---------------- Borrador ---------------- */
    function saveDraft() {
        if (editingId) return;
        clearTimeout(draftTimer);
        draftTimer = setTimeout(function () {
            try {
                localStorage.setItem(DRAFT_KEY, JSON.stringify({
                    nombre: $('#nombre').value,
                    telefono: $('#telefono').value,
                    monto: $('#monto').value,
                    modalidad: $('#modalidad').value,
                    fechaInicio: $('#fechaInicio').value,
                    notas: $('#notas').value
                }));
            } catch (e) { /* sin espacio: se ignora */ }
        }, 250);
    }

    function restoreDraft() {
        try {
            var raw = localStorage.getItem(DRAFT_KEY);
            if (!raw) return;
            var d = JSON.parse(raw);
            if (!d) return;
            if (d.nombre) $('#nombre').value = d.nombre;
            if (d.telefono) $('#telefono').value = d.telefono;
            if (d.monto) $('#monto').value = d.monto;
            if (d.modalidad && getModalidad(d.modalidad)) $('#modalidad').value = d.modalidad;
            if (d.fechaInicio) $('#fechaInicio').value = d.fechaInicio;
            if (d.notas) $('#notas').value = d.notas;
        } catch (e) { /* borrador inválido */ }
    }

    function clearDraft() {
        try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* nada */ }
    }

    /* ---------------- Formulario ---------------- */
    function setDefaultForm() {
        $('#nombre').value = '';
        $('#telefono').value = '';
        $('#monto').value = '1000';
        $('#fechaInicio').value = todayISO();
        $('#notas').value = '';
        $('#enviarWa').checked = true;
        if (db.modalidades.length) $('#modalidad').value = db.modalidades[0].id;
        $$('.field input.invalid').forEach(function (i) { i.classList.remove('invalid'); });
        updatePreview();
    }

    function resetForm() {
        editingId = null;
        $('#editingBanner').hidden = true;
        $('#btnGuardar').innerHTML = '<svg class="icon"><use href="#i-check"/></svg> Guardar cliente';
        setDefaultForm();
        clearDraft();
    }

    function validateForm() {
        var nombre = $('#nombre');
        var tel = $('#telefono');
        var monto = $('#monto');
        var fecha = $('#fechaInicio');
        var errores = [];

        $$('.field input.invalid').forEach(function (i) { i.classList.remove('invalid'); });

        if (nombre.value.trim().length < 3) { errores.push('Escribe el nombre completo del cliente.'); nombre.classList.add('invalid'); }
        if (normalizeTel(tel.value).length !== 10) { errores.push('El WhatsApp debe tener 10 dígitos.'); tel.classList.add('invalid'); }
        if (!monto.value || Number(monto.value) < 500 || Number(monto.value) > 20000) { errores.push('El monto debe estar entre $500 y $20,000.'); monto.classList.add('invalid'); }
        if (!fecha.value) { errores.push('Selecciona la fecha de inicio.'); fecha.classList.add('invalid'); }
        if (!getModalidad($('#modalidad').value)) { errores.push('Selecciona una modalidad de pago.'); }

        return errores;
    }

    function onSubmit(e) {
        e.preventDefault();
        var errores = validateForm();
        if (errores.length) {
            toast(errores[0], 'error');
            var first = $('.field input.invalid');
            if (first) first.focus();
            return;
        }

        var mod = getModalidad($('#modalidad').value);
        var monto = Number($('#monto').value);
        var fecha = $('#fechaInicio').value;
        var calc = buildSchedule(monto, mod, fecha);
        var now = new Date().toISOString();
        var base = {
            nombre: $('#nombre').value.trim(),
            telefono: normalizeTel($('#telefono').value),
            monto: monto,
            modalidadId: mod.id,
            modalidadNombre: mod.nombre,
            modalidadSnapshot: Object.assign({}, mod),
            fechaInicio: fecha,
            notas: $('#notas').value.trim(),
            total: calc.total,
            actualizado: now
        };

        var guardado;
        if (editingId) {
            var c = db.clientes.filter(function (x) { return x.id === editingId; })[0];
            if (!c) { resetForm(); toast('El cliente ya no existe.', 'error'); return; }
            var pagadosPrevios = {};
            (c.pagos || []).forEach(function (p) { pagadosPrevios[p.n] = p.pagado; });
            calc.pagos.forEach(function (p) { p.pagado = !!pagadosPrevios[p.n]; });
            Object.assign(c, base, { pagos: calc.pagos });
            guardado = c;
            saveDB();
            toast('Cliente actualizado', 'success');
            resetForm();
            renderClientes();
        } else {
            guardado = Object.assign({ id: uid(), creado: now }, base, { pagos: calc.pagos });
            db.clientes.unshift(guardado);
            saveDB();
            toast('Cliente guardado', 'success');
            if ($('#enviarWa').checked) abrirWhatsApp(guardado);
            resetForm();
            renderClientes();
        }

        if (currentClientId === guardado.id) renderClienteDetalle(guardado.id);
    }

    function startEdit(id) {
        var c = db.clientes.filter(function (x) { return x.id === id; })[0];
        if (!c) return;
        editingId = id;
        $('#nombre').value = c.nombre || '';
        $('#telefono').value = c.telefono || '';
        $('#monto').value = c.monto || '';
        $('#fechaInicio').value = c.fechaInicio || todayISO();
        $('#notas').value = c.notas || '';
        if (getModalidad(c.modalidadId)) $('#modalidad').value = c.modalidadId;
        $('#editingBanner').hidden = false;
        $('#btnGuardar').innerHTML = '<svg class="icon"><use href="#i-check"/></svg> Guardar cambios';
        updatePreview();
        closeModal($('#modalCliente'));
        $('#registro').scrollIntoView({ behavior: 'smooth', block: 'start' });
        setTimeout(function () { $('#nombre').focus(); }, 250);
    }

    /* ---------------- Panel ---------------- */
    function abrirPanel() {
        var panel = $('#panel');
        panel.hidden = false;
        renderClientes();
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function cerrarPanel() {
        $('#panel').hidden = true;
        $('#inicio').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    /* ---------------- Modales ---------------- */
    function openModal(el) {
        el.hidden = false;
        document.body.style.overflow = 'hidden';
        var focusable = el.querySelector('button, input, select, a');
        if (focusable) setTimeout(function () { focusable.focus(); }, 60);
    }

    function closeModal(el) {
        el.hidden = true;
        if (!$$('.modal:not([hidden])').length) document.body.style.overflow = '';
    }

    function abrirModalidades() {
        renderListaModalidades();
        resetModForm();
        openModal($('#modalModalidad'));
    }

    function resetModForm() {
        modalidadEditingId = null;
        $('#formModalidadTitulo').textContent = 'Nueva modalidad';
        $('#modNombre').value = '';
        $('#modFrecuencia').value = 'diaria';
        $('#modCadaDias').value = '15';
        $('#modNumeroPagos').value = '7';
        $('#modInteres').value = '20';
        $('#modOmitirDomingo').checked = true;
        $('#modCadaDiasField').hidden = true;
        $('#btnCancelarModalidad').hidden = true;
        $('#btnGuardarModalidad').innerHTML = '<svg class="icon"><use href="#i-check"/></svg> Guardar modalidad';
    }

    function startEditMod(id) {
        var m = getModalidad(id);
        if (!m) return;
        modalidadEditingId = id;
        $('#formModalidadTitulo').textContent = 'Editar modalidad';
        $('#modNombre').value = m.nombre;
        $('#modFrecuencia').value = m.frecuencia;
        $('#modCadaDias').value = m.cadaDias || 15;
        $('#modNumeroPagos').value = m.numeroPagos;
        $('#modInteres').value = m.interes;
        $('#modOmitirDomingo').checked = !!m.omitirDomingo;
        $('#modCadaDiasField').hidden = m.frecuencia !== 'personalizada';
        $('#btnCancelarModalidad').hidden = false;
        $('#btnGuardarModalidad').innerHTML = '<svg class="icon"><use href="#i-check"/></svg> Guardar cambios';
        $('#formModalidad').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function onModSubmit(e) {
        e.preventDefault();
        var nombre = $('#modNombre').value.trim();
        var frecuencia = $('#modFrecuencia').value;
        var cadaDias = frecuencia === 'personalizada' ? parseInt($('#modCadaDias').value, 10) : (frecuencia === 'diaria' ? 1 : 7);
        var numeroPagos = parseInt($('#modNumeroPagos').value, 10);
        var interes = Number($('#modInteres').value);

        if (nombre.length < 3) { toast('Escribe un nombre para la modalidad.', 'error'); $('#modNombre').focus(); return; }
        if (!numeroPagos || numeroPagos < 1 || numeroPagos > 120) { toast('El número de pagos debe ser entre 1 y 120.', 'error'); return; }
        if (isNaN(interes) || interes < 0 || interes > 200) { toast('El interés debe estar entre 0 y 200%.', 'error'); return; }
        if (frecuencia === 'personalizada' && (!cadaDias || cadaDias < 1 || cadaDias > 90)) { toast('Indica cada cuántos días se paga (1 a 90).', 'error'); return; }

        var data = {
            nombre: nombre,
            frecuencia: frecuencia,
            cadaDias: cadaDias,
            numeroPagos: numeroPagos,
            interes: interes,
            omitirDomingo: $('#modOmitirDomingo').checked
        };

        if (modalidadEditingId) {
            var m = getModalidad(modalidadEditingId);
            if (m) Object.assign(m, data);
            toast('Modalidad actualizada', 'success');
        } else {
            data.id = uid();
            db.modalidades.push(data);
            toast('Modalidad agregada', 'success');
        }
        saveDB();
        renderAll();
        renderListaModalidades();
        resetModForm();
        updatePreview();
    }

    function borrarModalidad(id) {
        if (db.modalidades.length <= 1) {
            toast('Debe existir al menos una modalidad.', 'error');
            return;
        }
        var m = getModalidad(id);
        if (!m) return;
        var usos = db.clientes.filter(function (c) { return c.modalidadId === id; }).length;
        var msg = usos
            ? 'La usan ' + usos + ' cliente(s). Sus calendarios ya guardados no cambiarán. ¿Eliminar la modalidad?'
            : '¿Eliminar la modalidad "' + m.nombre + '"?';
        if (!window.confirm(msg)) return;
        db.modalidades = db.modalidades.filter(function (x) { return x.id !== id; });
        saveDB();
        renderAll();
        renderListaModalidades();
        resetModForm();
        toast('Modalidad eliminada', 'success');
    }

    /* ---------------- Respaldos ---------------- */
    function download(filename, text, mime) {
        var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    function exportarJSON() {
        download('crefacil-respaldo-' + todayISO() + '.json', JSON.stringify(db, null, 2), 'application/json');
        toast('Respaldo descargado', 'success');
    }

    function exportarCSV() {
        var filas = [['Nombre', 'WhatsApp', 'Monto', 'Modalidad', 'Fecha inicio', 'Total', 'Pagado', 'Saldo', 'Estado', 'Notas']];
        db.clientes.forEach(function (c) {
            var s = clientStats(c);
            filas.push([
                c.nombre, c.telefono, c.monto, c.modalidadNombre || '', c.fechaInicio,
                s.total, s.pagado, s.saldo, s.estado, c.notas || ''
            ]);
        });
        var csv = '\uFEFF' + filas.map(function (fila) {
            return fila.map(function (v) {
                var txt = String(v == null ? '' : v).replace(/"/g, '""');
                return '"' + txt + '"';
            }).join(',');
        }).join('\r\n');
        download('crefacil-clientes-' + todayISO() + '.csv', csv, 'text/csv;charset=utf-8');
        toast('CSV descargado', 'success');
    }

    function importarArchivo(file) {
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
            try {
                var data = JSON.parse(reader.result);
                if (!data || !Array.isArray(data.clientes)) throw new Error('formato');
                var byId = {};
                db.clientes.forEach(function (c) { byId[c.id] = c; });
                data.clientes.forEach(function (c) {
                    if (c && c.id && Array.isArray(c.pagos)) byId[c.id] = c;
                });
                db.clientes = Object.keys(byId).map(function (k) { return byId[k]; });

                if (Array.isArray(data.modalidades)) {
                    var mods = {};
                    db.modalidades.forEach(function (m) { mods[m.id] = m; });
                    data.modalidades.forEach(function (m) { if (m && m.id) mods[m.id] = m; });
                    db.modalidades = Object.keys(mods).map(function (k) { return mods[k]; });
                }
                saveDB();
                renderAll();
                toast('Respaldo importado', 'success');
            } catch (e) {
                toast('El archivo no es un respaldo válido.', 'error');
            }
        };
        reader.readAsText(file);
    }

    /* ---------------- UI utilitarios ---------------- */
    function toast(msg, tipo) {
        var el = $('#toast');
        el.textContent = msg;
        el.className = 'toast' + (tipo ? ' ' + tipo : '');
        el.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { el.hidden = true; }, 3400);
    }

    function observeReveals() {
        var items = $$('.reveal:not(.visible)');
        if (!('IntersectionObserver' in window)) {
            items.forEach(function (el) { el.classList.add('visible'); });
            return;
        }
        var obs = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) {
                    entry.target.classList.add('visible');
                    obs.unobserve(entry.target);
                }
            });
        }, { threshold: 0.12 });
        items.forEach(function (el) { obs.observe(el); });
    }

    function initSteps() {
        var track = $('#stepsTrack');
        if (!track) return;
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        track.addEventListener('pointerdown', function () { track.dataset.paused = '1'; }, { passive: true });
        track.addEventListener('touchstart', function () { track.dataset.paused = '1'; }, { passive: true });
        track.addEventListener('mouseenter', function () { track.dataset.paused = '1'; });
        setInterval(function () {
            if (track.dataset.paused) return;
            var card = track.firstElementChild;
            if (!card) return;
            var maxScroll = track.scrollWidth - track.clientWidth;
            if (track.scrollLeft >= maxScroll - 8) {
                track.scrollTo({ left: 0, behavior: 'smooth' });
            } else {
                track.scrollBy({ left: card.getBoundingClientRect().width + 18, behavior: 'smooth' });
            }
        }, 4200);
    }

    function updateOnline() {
        var bar = $('#offlineBar');
        if (bar) bar.hidden = navigator.onLine;
    }

    /* ---------------- Eventos ---------------- */
    function bind() {
        $('#formRegistro').addEventListener('submit', onSubmit);

        $('#formRegistro').addEventListener('input', function (e) {
            if (e.target.classList) e.target.classList.remove('invalid');
            updatePreview();
            saveDraft();
        });
        $('#formRegistro').addEventListener('change', function () {
            updatePreview();
            saveDraft();
        });

        $('#montoChips').addEventListener('click', function (e) {
            var btn = e.target.closest('[data-monto]');
            if (!btn) return;
            $('#monto').value = btn.getAttribute('data-monto');
            updatePreview();
            saveDraft();
        });

        $('#btnLimpiar').addEventListener('click', function () {
            resetForm();
            toast('Formulario listo para un nuevo cliente');
        });

        $('#cancelarEdicion').addEventListener('click', function () {
            resetForm();
            toast('Edición cancelada');
        });

        document.addEventListener('click', function (e) {
            var openPanelBtn = e.target.closest('[data-open-panel]');
            if (openPanelBtn) { abrirPanel(); return; }

            var closeBtn = e.target.closest('[data-close-modal]');
            if (closeBtn) {
                var modal = closeBtn.closest('.modal');
                if (modal) {
                    if (modal.id === 'modalCliente') currentClientId = null;
                    closeModal(modal);
                }
                return;
            }

            var usar = e.target.closest('[data-usar-modalidad]');
            if (usar) {
                var id = usar.getAttribute('data-usar-modalidad');
                if (getModalidad(id)) {
                    $('#modalidad').value = id;
                    updatePreview();
                    saveDraft();
                    $('#registro').scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
                return;
            }

            var ver = e.target.closest('[data-ver-cliente]');
            if (ver) {
                renderClienteDetalle(ver.getAttribute('data-ver-cliente'));
                openModal($('#modalCliente'));
                return;
            }

            var wa = e.target.closest('[data-wa-cliente]');
            if (wa) {
                var c = db.clientes.filter(function (x) { return x.id === wa.getAttribute('data-wa-cliente'); })[0];
                if (c) abrirWhatsApp(c);
                return;
            }

            var editMod = e.target.closest('[data-edit-mod]');
            if (editMod) { startEditMod(editMod.getAttribute('data-edit-mod')); return; }

            var delMod = e.target.closest('[data-del-mod]');
            if (delMod) { borrarModalidad(delMod.getAttribute('data-del-mod')); return; }
        });

        $('#btnCerrarPanel').addEventListener('click', cerrarPanel);
        $('#buscar').addEventListener('input', renderClientes);
        $('#filtroModalidad').addEventListener('change', renderClientes);
        $('#filtroEstado').addEventListener('change', renderClientes);

        $('#clienteDetalle').addEventListener('change', function (e) {
            var chk = e.target.closest('[data-pay]');
            if (!chk || !currentClientId) return;
            var c = db.clientes.filter(function (x) { return x.id === currentClientId; })[0];
            if (!c) return;
            var idx = parseInt(chk.getAttribute('data-pay'), 10);
            if (!c.pagos[idx]) return;
            c.pagos[idx].pagado = chk.checked;
            c.actualizado = new Date().toISOString();
            saveDB();
            var scroll = $('#clienteDetalle').scrollTop;
            renderClienteDetalle(currentClientId);
            $('#clienteDetalle').scrollTop = scroll;
            renderClientes();
            toast(chk.checked ? 'Pago marcado' : 'Pago desmarcado', 'success');
        });

        $('#clienteAcciones').addEventListener('click', function (e) {
            if (!currentClientId) return;
            if (e.target.closest('[data-ver-editar]')) { startEdit(currentClientId); return; }
            if (e.target.closest('[data-ver-eliminar]')) {
                var c = db.clientes.filter(function (x) { return x.id === currentClientId; })[0];
                if (!c) return;
                if (!window.confirm('¿Eliminar a ' + c.nombre + '? Esta acción no se puede deshacer.')) return;
                db.clientes = db.clientes.filter(function (x) { return x.id !== currentClientId; });
                saveDB();
                currentClientId = null;
                closeModal($('#modalCliente'));
                renderClientes();
                toast('Cliente eliminado', 'success');
            }
        });

        $('#btnExportarJson').addEventListener('click', exportarJSON);
        $('#btnExportarCsv').addEventListener('click', exportarCSV);
        $('#btnImportar').addEventListener('click', function () { $('#importarArchivo').click(); });
        $('#importarArchivo').addEventListener('change', function (e) {
            importarArchivo(e.target.files[0]);
            e.target.value = '';
        });
        $('#btnAdministrarModalidades').addEventListener('click', abrirModalidades);
        $('#btnNuevaModalidad').addEventListener('click', abrirModalidades);

        $('#formModalidad').addEventListener('submit', onModSubmit);
        $('#modFrecuencia').addEventListener('change', function () {
            var esCustom = $('#modFrecuencia').value === 'personalizada';
            $('#modCadaDiasField').hidden = !esCustom;
            if (!$('#modNumeroPagos').value || Number($('#modNumeroPagos').value) === 7) {
                $('#modNumeroPagos').value = esCustom ? '4' : ($('#modFrecuencia').value === 'semanal' ? '4' : '7');
            }
        });
        $('#btnCancelarModalidad').addEventListener('click', resetModForm);

        window.addEventListener('online', updateOnline);
        window.addEventListener('offline', updateOnline);
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                $$('.modal:not([hidden])').forEach(function (m) {
                    if (m.id === 'modalCliente') currentClientId = null;
                    closeModal(m);
                });
            }
        });
    }

    /* ---------------- Arranque ---------------- */
    function init() {
        $('#fechaInicio').value = todayISO();
        var anio = $('#anio');
        if (anio) anio.textContent = String(new Date().getFullYear());

        renderModalidadOptions();
        renderModalidadesGrid();
        renderFiltroModalidad();
        restoreDraft();
        updatePreview();
        renderClientes();
        bind();
        observeReveals();
        initSteps();
        updateOnline();

        if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
            window.addEventListener('load', function () {
                navigator.serviceWorker.register('sw.js').catch(function () { /* sin soporte offline */ });
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
