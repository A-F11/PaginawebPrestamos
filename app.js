(function () {
    'use strict';

    var DB_KEY = 'crefacil_db_v3';
    var LEGACY_KEY = 'crefacil_db_v2';

    var DEFAULT_PLANTILLAS = [
        { id: 'diaria', nombre: 'Pago diario', frecuencia: 'diaria', cadaDias: 1, numeroPagos: 7, interes: 20, omitirDomingo: true },
        { id: 'semanal', nombre: 'Pago semanal', frecuencia: 'semanal', cadaDias: 7, numeroPagos: 4, interes: 25, omitirDomingo: true }
    ];

    var CAL_LABEL = { bueno: 'Buen historial', regular: 'Historial regular', riesgo: 'En riesgo', sin: 'Sin historial' };
    var CAL_CLASS = { bueno: 'badge-ok', regular: 'badge-warn', riesgo: 'badge-danger', sin: 'badge-gray' };

    function $(sel, root) { return (root || document).querySelector(sel); }
    function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

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
    function diffDays(a, b) {
        if (!a || !b) return 0;
        return Math.round((parseISO(a).getTime() - parseISO(b).getTime()) / 86400000);
    }
    function fmtFecha(iso) {
        if (!iso) return '—';
        return parseISO(iso).toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });
    }
    function fmtFechaLarga(iso) {
        if (!iso) return '—';
        return parseISO(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });
    }
    function fechaLocalDe(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        return isNaN(d.getTime()) ? String(iso).slice(0, 10) : toISO(d);
    }
    function normalizeTel(v) {
        var d = String(v || '').replace(/\D/g, '');
        if (d.length > 10) d = d.slice(-10);
        return d;
    }
    function fmtTel(v) {
        var d = normalizeTel(v);
        return d.length === 10 ? d.slice(0, 3) + ' ' + d.slice(3, 6) + ' ' + d.slice(6) : (v || '—');
    }
    function uid() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
        return 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }
    function nowISO() { return new Date().toISOString(); }

    var db = null;
    var migrated = false;
    var currentDeudorId = null;
    var currentPrestamoId = null;
    var formState = { mode: 'nuevo', deudorId: null, prestamoId: null };
    var editingPlantillaId = null;
    var editingDeudorId = null;
    var searchDeudor = '';
    var filtroDeudor = 'todos';
    var toastTimer = null;

    /* ================= Datos ================= */
    function defaultPlantillas() {
        return DEFAULT_PLANTILLAS.map(function (p) { return Object.assign({}, p); });
    }

    function seedDB() {
        return { version: 3, creado: nowISO(), modalidades: defaultPlantillas(), deudores: [], prestamos: [], config: {} };
    }

    function migrateLegacy(legacy) {
        var out = seedDB();
        out.modalidades = Array.isArray(legacy.modalidades) && legacy.modalidades.length ? legacy.modalidades : defaultPlantillas();
        out.config = legacy.config || {};
        var now = nowISO();
        (legacy.clientes || []).forEach(function (c) {
            var deudorId = c.id || uid();
            out.deudores.push({
                id: deudorId,
                nombre: c.nombre || 'Sin nombre',
                telefono: c.telefono || '',
                notas: c.notas || '',
                creado: c.creado || now,
                actualizado: c.actualizado || now
            });
            var pagos = (c.pagos || []).map(function (p, i) {
                return {
                    n: p.n || i + 1,
                    fecha: p.fecha || c.fechaInicio || todayISO(),
                    monto: round2(p.monto),
                    pagado: !!p.pagado,
                    fechaPago: p.pagado ? (p.fechaPago || p.fecha || c.fechaInicio || todayISO()) : null
                };
            });
            var total = Number(c.total) || round2(pagos.reduce(function (s, p) { return s + p.monto; }, 0));
            var pagado = round2(pagos.reduce(function (s, p) { return s + (p.pagado ? p.monto : 0); }, 0));
            var liquidado = pagado >= total - 0.009;
            var ultimoPago = pagos.filter(function (p) { return p.pagado; }).map(function (p) { return p.fechaPago; }).sort().pop();
            out.prestamos.push({
                id: uid(),
                deudorId: deudorId,
                monto: Number(c.monto) || total,
                montoEntregado: Number(c.monto) || total,
                saldoArrastrado: 0,
                interes: c.modalidadSnapshot ? Number(c.modalidadSnapshot.interes) || 0 : 0,
                total: total,
                modalidadId: c.modalidadId || null,
                modalidadNombre: c.modalidadNombre || 'Modalidad anterior',
                modalidadSnapshot: c.modalidadSnapshot || { frecuencia: 'diaria', cadaDias: 1, numeroPagos: pagos.length || 1, interes: 0, omitirDomingo: true },
                fechaInicio: c.fechaInicio || todayISO(),
                pagos: pagos,
                estado: liquidado ? 'liquidado' : 'activo',
                liquidadoEn: liquidado ? ultimoPago || todayISO() : null,
                montoLiquidado: 0,
                liquidacionAnticipada: false,
                renovadoDe: null,
                renovadoPor: null,
                creado: c.creado || now,
                actualizado: c.actualizado || now
            });
        });
        return out;
    }

    function sanitizeDB(data) {
        if (!data || typeof data !== 'object') throw new Error('formato');
        var out = seedDB();
        out.creado = data.creado || out.creado;
        out.config = data.config && typeof data.config === 'object' ? data.config : {};
        out.modalidades = Array.isArray(data.modalidades) && data.modalidades.length
            ? data.modalidades.filter(function (m) { return m && m.id && m.nombre; })
            : defaultPlantillas();
        if (!out.modalidades.length) out.modalidades = defaultPlantillas();
        out.deudores = Array.isArray(data.deudores) ? data.deudores.filter(function (d) { return d && d.id; }) : [];
        out.prestamos = (Array.isArray(data.prestamos) ? data.prestamos : []).filter(function (p) {
            return p && p.id && p.deudorId && Array.isArray(p.pagos);
        }).map(function (p) {
            var pagos = p.pagos.map(function (pay, i) {
                return {
                    n: pay.n || i + 1,
                    fecha: pay.fecha || todayISO(),
                    monto: round2(pay.monto),
                    pagado: !!pay.pagado,
                    fechaPago: pay.pagado ? (pay.fechaPago || pay.fecha || todayISO()) : null
                };
            });
            return Object.assign({}, p, {
                monto: Number(p.monto) || 0,
                montoEntregado: Number(p.montoEntregado) || Number(p.monto) || 0,
                saldoArrastrado: Number(p.saldoArrastrado) || 0,
                interes: Number(p.interes) || 0,
                total: Number(p.total) || round2(pagos.reduce(function (s, x) { return s + x.monto; }, 0)),
                pagos: pagos,
                estado: p.estado || 'activo',
                modalidadSnapshot: p.modalidadSnapshot || { frecuencia: 'diaria', cadaDias: 1, numeroPagos: pagos.length, interes: Number(p.interes) || 0, omitirDomingo: true }
            });
        });
        return out;
    }

    function loadDB() {
        try {
            var raw = localStorage.getItem(DB_KEY);
            if (raw) {
                var parsed = JSON.parse(raw);
                if (parsed && parsed.version === 3) return sanitizeDB(parsed);
            }
        } catch (e) { /* continuar */ }

        try {
            var legacyRaw = localStorage.getItem(LEGACY_KEY);
            if (legacyRaw) {
                var legacy = JSON.parse(legacyRaw);
                if (legacy && Array.isArray(legacy.clientes)) {
                    migrated = true;
                    var converted = migrateLegacy(legacy);
                    try { localStorage.setItem(DB_KEY, JSON.stringify(converted)); } catch (e2) { /* sin espacio */ }
                    return converted;
                }
            }
        } catch (e3) { /* sin datos viejos */ }

        return seedDB();
    }

    function saveDB() {
        try {
            localStorage.setItem(DB_KEY, JSON.stringify(db));
            return true;
        } catch (e) {
            toast('No se pudo guardar. Revisa el espacio del navegador.', 'error');
            return false;
        }
    }

    /* ================= Consultas ================= */
    function getDeudor(id) { return (db.deudores || []).filter(function (d) { return d.id === id; })[0] || null; }
    function getPrestamo(id) { return (db.prestamos || []).filter(function (p) { return p.id === id; })[0] || null; }
    function getPlantilla(id) { return (db.modalidades || []).filter(function (m) { return m.id === id; })[0] || null; }
    function prestamosDe(deudorId) { return (db.prestamos || []).filter(function (p) { return p.deudorId === deudorId; }); }
    function pagosDePrestamo(p) { return Array.isArray(p.pagos) ? p.pagos : []; }
    function sumaPagos(p) { return round2(pagosDePrestamo(p).reduce(function (s, x) { return s + (Number(x.monto) || 0); }, 0)); }
    function pagadoPrestamo(p) { return round2(pagosDePrestamo(p).reduce(function (s, x) { return s + (x.pagado ? (Number(x.monto) || 0) : 0); }, 0)); }
    function esCerrado(p) { return p.estado === 'liquidado' || p.estado === 'renovado' || p.estado === 'cancelado'; }

    function loanStats(p) {
        var pagos = pagosDePrestamo(p);
        var total = Number(p.total) || sumaPagos(p);
        var pagado = pagadoPrestamo(p);
        var cerrado = esCerrado(p);
        var hoy = todayISO();
        var saldo;
        if (p.estado === 'liquidado' || p.estado === 'renovado' || p.estado === 'cancelado') saldo = 0;
        else saldo = Math.max(0, round2(total - pagado));

        var vencidosList = cerrado ? [] : pagos.filter(function (x) { return !x.pagado && x.fecha < hoy; });
        var vencidos = vencidosList.length;
        var vencidoMonto = round2(vencidosList.reduce(function (s, x) { return s + (Number(x.monto) || 0); }, 0));
        var atrasoActual = 0;
        vencidosList.forEach(function (x) {
            var d = Math.max(0, diffDays(hoy, x.fecha));
            if (d > atrasoActual) atrasoActual = d;
        });
        var pendientes = pagos.filter(function (x) { return !x.pagado; });
        var proximo = pendientes.slice().sort(function (a, b) { return String(a.fecha).localeCompare(String(b.fecha)); })[0] || null;
        var pagadosCount = pagos.filter(function (x) { return x.pagado; }).length;
        if (p.estado === 'liquidado') {
            pagado = p.liquidacionAnticipada
                ? round2(pagado + (Number(p.montoLiquidado) || 0))
                : Math.max(pagado, total);
        }

        return {
            total: total,
            pagado: pagado,
            saldo: saldo,
            vencidos: vencidos,
            vencidoMonto: vencidoMonto,
            atrasoActual: atrasoActual,
            proximo: proximo,
            pagadosCount: pagadosCount,
            pagosCount: pagos.length
        };
    }

    function loanEstado(p) {
        if (p.estado === 'renovado') return { label: 'Renovado', clase: 'badge-blue' };
        if (p.estado === 'cancelado') return { label: 'Cancelado', clase: 'badge-gray' };
        if (p.estado === 'liquidado') {
            return p.liquidacionAnticipada
                ? { label: 'Liquidado antes', clase: 'badge-blue' }
                : { label: 'Liquidado', clase: 'badge-ok' };
        }
        var st = loanStats(p);
        if (st.atrasoActual > 0) return { label: 'Atrasado ' + st.atrasoActual + 'd', clase: 'badge-danger' };
        return { label: 'Activo', clase: 'badge-ok' };
    }

    function deudorMetrics(id) {
        var loans = prestamosDe(id);
        var hoy = todayISO();
        var puntuales = 0, tarde = 0, diasAtraso = 0, maxAtraso = 0, evaluables = 0;
        var saldo = 0, totalPrestado = 0, totalPagado = 0, activos = 0, renovaciones = 0;
        var atrasoActual = 0;

        loans.forEach(function (p) {
            totalPrestado += Number(p.montoEntregado) || Number(p.monto) || 0;
            if (p.renovadoDe) renovaciones++;
            var st = loanStats(p);
            saldo += st.saldo;
            totalPagado += st.pagado;
            if (p.estado === 'activo') activos++;
            if (st.atrasoActual > atrasoActual) atrasoActual = st.atrasoActual;

            var cerrado = esCerrado(p);
            pagosDePrestamo(p).forEach(function (pay) {
                if (pay.pagado) {
                    evaluables++;
                    var delay = 0;
                    if (pay.fechaPago && pay.fecha) delay = Math.max(0, diffDays(pay.fechaPago, pay.fecha));
                    if (delay <= 0) puntuales++;
                    else {
                        tarde++;
                        diasAtraso += delay;
                        if (delay > maxAtraso) maxAtraso = delay;
                    }
                } else if (!cerrado && pay.fecha < hoy) {
                    evaluables++;
                    tarde++;
                    var d = Math.max(0, diffDays(hoy, pay.fecha));
                    diasAtraso += d;
                    if (d > maxAtraso) maxAtraso = d;
                }
            });
        });

        var cumplimiento = evaluables ? Math.round((puntuales / evaluables) * 100) : null;
        var calificacion = 'sin';
        if (evaluables > 0) {
            if (cumplimiento >= 90 && atrasoActual === 0) calificacion = 'bueno';
            else if (cumplimiento < 70 || maxAtraso > 7) calificacion = 'riesgo';
            else calificacion = 'regular';
        }

        return {
            prestamos: loans.length,
            activos: activos,
            saldo: round2(saldo),
            totalPrestado: round2(totalPrestado),
            totalPagado: round2(totalPagado),
            puntuales: puntuales,
            tarde: tarde,
            evaluables: evaluables,
            diasAtraso: diasAtraso,
            maxAtraso: maxAtraso,
            atrasoActual: atrasoActual,
            cumplimiento: cumplimiento,
            calificacion: calificacion,
            renovaciones: renovaciones
        };
    }

    function cobrosPendientes() {
        var hoy = todayISO();
        var out = [];
        (db.prestamos || []).forEach(function (p) {
            if (p.estado !== 'activo') return;
            var d = getDeudor(p.deudorId);
            pagosDePrestamo(p).forEach(function (pay, i) {
                if (!pay.pagado && pay.fecha <= hoy) {
                    out.push({ prestamo: p, deudor: d, pago: pay, index: i, dias: Math.max(0, diffDays(hoy, pay.fecha)) });
                }
            });
        });
        return out.sort(function (a, b) {
            return (b.dias - a.dias) || String(a.pago.fecha).localeCompare(String(b.pago.fecha));
        });
    }

    function buildSchedule(baseMonto, mod, fechaInicio) {
        var base = Number(baseMonto) || 0;
        var total = round2(base * (1 + (Number(mod.interes) || 0) / 100));
        var n = Math.max(1, Math.min(120, parseInt(mod.numeroPagos, 10) || 1));
        var step = mod.frecuencia === 'diaria' ? 1 : mod.frecuencia === 'semanal' ? 7 : Math.max(1, parseInt(mod.cadaDias, 10) || 1);
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
            var monto = i === n ? round2(total - acumulado) : round2(total / n);
            acumulado = round2(acumulado + monto);
            pagos.push({ n: i, fecha: toISO(cur), monto: monto, pagado: false, fechaPago: null });
        }
        return { total: total, pagos: pagos };
    }

    function recomputeTotal(p) { p.total = sumaPagos(p); }

    function normalizeLoanState(p) {
        if (p.estado !== 'activo' && p.estado !== 'liquidado') return;
        if (p.liquidacionAnticipada) return;
        var pagado = pagadoPrestamo(p);
        var total = Number(p.total) || 0;
        if (total > 0 && pagado >= total - 0.009) {
            p.estado = 'liquidado';
            p.liquidadoEn = p.liquidadoEn || todayISO();
            p.liquidacionAnticipada = false;
            p.montoLiquidado = 0;
        } else if (p.estado === 'liquidado') {
            p.estado = 'activo';
            p.liquidadoEn = null;
            p.montoLiquidado = 0;
        }
    }

    /* ================= UI utilitarios ================= */
    function toast(msg, tipo) {
        var el = $('#toast');
        if (!el) return;
        el.textContent = msg;
        el.className = 'toast' + (tipo ? ' ' + tipo : '');
        el.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { el.hidden = true; }, 3200);
    }

    function openModal(el) {
        el.hidden = false;
        document.body.style.overflow = 'hidden';
        var focusable = el.querySelector('input, button, select');
        if (focusable) setTimeout(function () { focusable.focus(); }, 60);
    }

    function closeModal(el) {
        el.hidden = true;
        if (!$$('.modal:not([hidden])').length) document.body.style.overflow = '';
    }

    function closeAllModals() {
        $$('.modal:not([hidden])').forEach(function (m) { m.hidden = true; });
        document.body.style.overflow = '';
    }

    function statCard(icon, colorClass, label, value, sub) {
        return '<div class="stat-card">' +
            '<div class="stat-icon ' + colorClass + '"><svg class="icon"><use href="#i-' + icon + '"/></svg></div>' +
            '<div style="min-width:0">' +
            '<div class="stat-label">' + esc(label) + '</div>' +
            '<div class="stat-value">' + value + '</div>' +
            (sub ? '<div class="stat-sub">' + sub + '</div>' : '') +
            '</div></div>';
    }

    function qualBadge(cal) {
        return '<span class="badge ' + CAL_CLASS[cal] + '">' + CAL_LABEL[cal] + '</span>';
    }

    function proximoPagoDe(deudorId) {
        var proximos = [];
        prestamosDe(deudorId).forEach(function (p) {
            if (p.estado !== 'activo') return;
            pagosDePrestamo(p).forEach(function (pay) {
                if (!pay.pagado) proximos.push(pay);
            });
        });
        proximos.sort(function (a, b) { return String(a.fecha).localeCompare(String(b.fecha)); });
        return proximos[0] || null;
    }

    function waHref(phone, text) {
        var tel = normalizeTel(phone);
        return 'https://wa.me/' + (tel.length === 10 ? '52' + tel : '') + '?text=' + encodeURIComponent(text);
    }

    function mensajePrestamo(p, d) {
        var st = loanStats(p);
        var lines = [
            'Hola ' + (d && d.nombre ? d.nombre : '') + ', te comparto el estado de tu préstamo:',
            'Monto: ' + money(p.monto),
            'Total a pagar: ' + money(st.total),
            'Pagado: ' + money(st.pagado),
            'Saldo: ' + money(st.saldo),
            'Modalidad: ' + (p.modalidadNombre || '—')
        ];
        if (st.proximo && p.estado === 'activo') {
            lines.push('Próximo pago: ' + money(st.proximo.monto) + ' el ' + fmtFechaLarga(st.proximo.fecha));
        } else if (p.estado === 'liquidado') {
            lines.push('Préstamo liquidado. ¡Gracias!');
        }
        return lines.join('\n');
    }

    function compartirPrestamo(p, d) {
        window.open(waHref(d ? d.telefono : '', mensajePrestamo(p, d || {})), '_blank', 'noopener');
    }

    /* ================= Navegación ================= */
    function navigate(name, opts) {
        opts = opts || {};
        if (name === 'deudor') {
            currentDeudorId = opts.deudorId || currentDeudorId;
            if (!getDeudor(currentDeudorId)) name = 'deudores';
        }
        if (name === 'prestamo') {
            currentPrestamoId = opts.prestamoId || currentPrestamoId;
            var p = getPrestamo(currentPrestamoId);
            if (!p) name = 'deudores';
            else currentDeudorId = p.deudorId;
        }

        closeAllModals();
        $$('.view').forEach(function (v) { v.hidden = true; });
        var el = $('#view-' + name);
        if (el) el.hidden = false;

        if (name === 'inicio') renderDashboard();
        if (name === 'deudores') renderDeudores();
        if (name === 'deudor') renderDeudor();
        if (name === 'prestamo') renderPrestamo();

        var active = name === 'inicio' ? 'inicio'
            : (name === 'deudores' || name === 'deudor' || name === 'prestamo') ? 'deudores'
                : null;
        $$('[data-nav]').forEach(function (b) {
            b.classList.toggle('is-active', !!active && b.getAttribute('data-nav') === active);
        });

        window.scrollTo(0, 0);
    }

    /* ================= Dashboard ================= */
    function renderDashboard() {
        var hoy = todayISO();
        var fechaEl = $('#inicioFecha');
        if (fechaEl) fechaEl.textContent = new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

        var saldoTotal = 0, cobradoHoy = 0, vencidoTotal = 0, activos = 0, pagosHoyCount = 0, vencidosCount = 0;
        (db.prestamos || []).forEach(function (p) {
            var st = loanStats(p);
            saldoTotal += st.saldo;
            vencidoTotal += st.vencidoMonto;
            vencidosCount += st.vencidos;
            if (p.estado === 'activo') activos++;
            pagosDePrestamo(p).forEach(function (pay) {
                if (pay.pagado && pay.fechaPago === hoy) {
                    cobradoHoy += Number(pay.monto) || 0;
                    pagosHoyCount++;
                }
            });
            if (p.liquidadoEn === hoy && p.montoLiquidado) cobradoHoy += Number(p.montoLiquidado) || 0;
        });
        var deudoresActivos = db.deudores.filter(function (d) {
            return prestamosDe(d.id).some(function (p) { return p.estado === 'activo'; });
        }).length;

        $('#statsGrid').innerHTML =
            statCard('wallet', 'blue', 'Por cobrar', money(saldoTotal), activos + ' préstamo(s) activos') +
            statCard('check', '', 'Cobrado hoy', money(cobradoHoy), pagosHoyCount + ' pago(s) registrados hoy') +
            statCard('alert', 'red', 'Vencido', money(vencidoTotal), vencidosCount + ' pago(s) atrasados') +
            statCard('users', 'green', 'Deudores activos', String(deudoresActivos), db.deudores.length + ' deudor(es) en total');

        var cobros = cobrosPendientes();
        var badge = $('#cobrosHoyCount');
        if (badge) {
            badge.hidden = cobros.length === 0;
            badge.textContent = cobros.length + ' pendiente(s)';
            badge.className = 'badge ' + (cobros.some(function (c) { return c.dias > 0; }) ? 'badge-warn' : 'badge-blue');
        }

        var cont = $('#cobrosHoy');
        if (!cobros.length) {
            cont.innerHTML = '<div class="empty-state"><strong>Sin cobros pendientes</strong>No hay pagos de hoy ni atrasados. Buen momento para revisar tu cartera.</div>';
        } else {
            cont.innerHTML = '<div class="cobros-list">' + cobros.slice(0, 40).map(function (c) {
                var d = c.deudor || { nombre: 'Deudor eliminado', telefono: '' };
                var etiqueta = c.dias > 0 ? 'Venció hace ' + c.dias + ' día(s)' : 'Vence hoy';
                return '<div class="cobro-row ' + (c.dias > 0 ? 'is-late' : '') + '">' +
                    '<div class="cobro-main"><strong>' + esc(d.nombre) + '</strong><small>Pago ' + c.pago.n + ' de ' + pagosDePrestamo(c.prestamo).length + ' · ' + etiqueta + ' · ' + esc(c.prestamo.modalidadNombre || '') + '</small></div>' +
                    '<div class="cobro-amount">' + money(c.pago.monto) + '</div>' +
                    '<div class="cobro-actions">' +
                    '<button type="button" class="btn btn-pay" data-cobrar="' + esc(c.prestamo.id) + '|' + c.index + '"><svg class="icon"><use href="#i-check"/></svg> Pagado</button>' +
                    '<button type="button" class="btn btn-ghost" data-ver-prestamo="' + esc(c.prestamo.id) + '">Ver</button>' +
                    '</div></div>';
            }).join('') + '</div>';
        }

        var recientes = db.deudores.slice().sort(function (a, b) {
            return String(b.actualizado || b.creado || '').localeCompare(String(a.actualizado || a.creado || ''));
        }).slice(0, 6);
        var recientesEl = $('#deudoresRecientes');
        if (!recientes.length) {
            recientesEl.innerHTML = '<div class="empty-state"><strong>Aún no hay deudores</strong>Registra tu primer préstamo para empezar a controlar tus cobros.<br><br><button type="button" class="btn btn-primary btn-sm" data-nuevo>+ Nuevo préstamo</button></div>';
        } else {
            recientesEl.innerHTML = recientes.map(deudorCardHTML).join('');
        }
    }

    function deudorCardHTML(d) {
        var m = deudorMetrics(d.id);
        var prox = proximoPagoDe(d.id);
        var atraso = m.atrasoActual > 0 ? '<span class="late-text">Atraso ' + m.atrasoActual + 'd</span>' : 'Al corriente';
        return '<article class="deudor-card">' +
            '<div class="deudor-top">' +
            '<div><h3>' + esc(d.nombre) + '</h3><p>' + esc(fmtTel(d.telefono)) + '</p></div>' +
            qualBadge(m.calificacion) +
            '</div>' +
            '<div class="deudor-data">' +
            '<span>Saldo <b>' + money(m.saldo) + '</b></span>' +
            '<span>' + (m.activos ? m.activos + ' activo(s)' : 'Sin préstamo activo') + '</span>' +
            '<span>' + atraso + '</span>' +
            '</div>' +
            '<div class="deudor-data"><span>' + (prox ? 'Próximo: <b>' + money(prox.monto) + '</b> · ' + fmtFecha(prox.fecha) : 'Sin pagos pendientes') + '</span></div>' +
            '<div class="deudor-foot">' +
            '<button type="button" class="btn btn-outline" data-ver-deudor="' + esc(d.id) + '">Historial</button>' +
            '<button type="button" class="btn btn-ghost" data-wa-deudor="' + esc(d.id) + '"><svg class="icon icon-fill"><use href="#i-wa"/></svg> WhatsApp</button>' +
            '</div></article>';
    }

    function renderDeudores() {
        var cont = $('#listaDeudores');
        if (!cont) return;
        var q = searchDeudor.trim().toLowerCase();
        var lista = db.deudores.filter(function (d) {
            if (q && String(d.nombre || '').toLowerCase().indexOf(q) === -1 && String(d.telefono || '').indexOf(q) === -1) return false;
            var m = deudorMetrics(d.id);
            if (filtroDeudor === 'activos' && m.activos === 0) return false;
            if (filtroDeudor === 'atrasados' && m.atrasoActual === 0) return false;
            if (filtroDeudor === 'liquidados' && m.saldo > 0) return false;
            if (filtroDeudor === 'riesgo' && m.calificacion !== 'riesgo') return false;
            return true;
        });
        lista.sort(function (a, b) {
            var ma = deudorMetrics(a.id), mb = deudorMetrics(b.id);
            var aa = ma.atrasoActual > 0 ? 1 : 0, bb = mb.atrasoActual > 0 ? 1 : 0;
            if (aa !== bb) return bb - aa;
            return String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es');
        });
        if (!lista.length) {
            cont.innerHTML = '<div class="empty-state"><strong>' + (db.deudores.length ? 'Sin resultados' : 'Aún no hay deudores') + '</strong>' +
                (db.deudores.length ? 'Prueba con otra búsqueda o filtro.' : 'Crea un préstamo para registrar a tu primer deudor.') + '</div>';
            return;
        }
        cont.innerHTML = lista.map(deudorCardHTML).join('');
    }

    /* ================= Detalle del deudor ================= */
    function renderDeudor() {
        var d = getDeudor(currentDeudorId);
        if (!d) { navigate('deudores'); return; }
        var m = deudorMetrics(d.id);
        var loans = prestamosDe(d.id).slice().sort(function (a, b) {
            return String(b.creado || '').localeCompare(String(a.creado || ''));
        });

        $('#deudorHeader').innerHTML =
            '<div class="entity-head">' +
            '<div style="min-width:0">' +
            '<div class="entity-title"><h1>' + esc(d.nombre) + '</h1>' + qualBadge(m.calificacion) + '</div>' +
            '<div class="entity-sub">' +
            '<span><svg class="icon"><use href="#i-phone"/></svg> ' + esc(fmtTel(d.telefono)) + '</span>' +
            '<span>Deudor desde ' + fmtFechaLarga(fechaLocalDe(d.creado)) + '</span>' +
            (m.renovaciones ? '<span>' + m.renovaciones + ' renovación(es)</span>' : '') +
            '</div>' +
            (d.notas ? '<div class="entity-sub"><span><b>Notas:</b> ' + esc(d.notas) + '</span></div>' : '') +
            '</div>' +
            '<div class="entity-actions">' +
            '<button type="button" class="btn btn-ghost" data-editar-deudor="' + esc(d.id) + '"><svg class="icon"><use href="#i-edit"/></svg> Editar</button>' +
            '<button type="button" class="btn btn-ghost" data-wa-deudor="' + esc(d.id) + '"><svg class="icon icon-fill"><use href="#i-wa"/></svg> WhatsApp</button>' +
            '<button type="button" class="btn btn-primary" data-nuevo-deudor="' + esc(d.id) + '"><svg class="icon"><use href="#i-plus"/></svg> Nuevo préstamo</button>' +
            '</div></div>';

        $('#deudorStats').innerHTML =
            statCard('wallet', 'blue', 'Saldo actual', money(m.saldo), m.activos + ' préstamo(s) activo(s)') +
            statCard('money', '', 'Total prestado', money(m.totalPrestado), m.prestamos + ' préstamo(s) en total') +
            statCard('check', '', 'Pagos a tiempo', String(m.puntuales), m.tarde + ' pago(s) con atraso') +
            statCard('history', m.calificacion === 'riesgo' ? 'red' : m.calificacion === 'regular' ? 'amber' : '', 'Cumplimiento', m.cumplimiento == null ? '—' : m.cumplimiento + '%', 'De ' + m.evaluables + ' pago(s) evaluados') +
            statCard('alert', m.atrasoActual > 0 ? 'red' : 'green', 'Atraso actual', m.atrasoActual > 0 ? m.atrasoActual + ' días' : 'Ninguno', m.maxAtraso > 0 ? 'Máximo histórico: ' + m.maxAtraso + ' días' : 'Sin atrasos registrados') +
            statCard('refresh', 'blue', 'Renovaciones', String(m.renovaciones), 'Préstamos renovados');

        $('#deudorRecomendacion').innerHTML = recommendationHTML(m);

        var countEl = $('#deudorHistorialCount');
        if (countEl) countEl.textContent = loans.length + ' préstamo(s)';

        var cont = $('#deudorPrestamos');
        if (!loans.length) {
            cont.innerHTML = '<div class="empty-state"><strong>Sin préstamos</strong>Este deudor todavía no tiene préstamos registrados.<br><br><button type="button" class="btn btn-primary btn-sm" data-nuevo-deudor="' + esc(d.id) + '">+ Nuevo préstamo</button></div>';
        } else {
            cont.innerHTML = loans.map(loanCardHTML).join('');
        }
    }

    function recommendationHTML(m) {
        if (m.calificacion === 'sin') {
            return '<div class="advice advice-sin"><svg class="icon"><use href="#i-history"/></svg><div><strong>Sin historial todavía</strong><p>Aún no hay pagos evaluados. Cuando registres pagos podrás ver si conviene renovar.</p></div></div>';
        }
        if (m.calificacion === 'bueno') {
            return '<div class="advice advice-bueno"><svg class="icon"><use href="#i-check"/></svg><div><strong>Buen historial: puedes renovar con confianza</strong><p>' + m.puntuales + ' de ' + m.evaluables + ' pagos fueron a tiempo (' + m.cumplimiento + '%). Sin atrasos actuales. Renovaciones: ' + m.renovaciones + '.</p></div></div>';
        }
        if (m.calificacion === 'riesgo') {
            return '<div class="advice advice-riesgo"><svg class="icon"><use href="#i-alert"/></svg><div><strong>Historial de riesgo: revisa antes de renovar</strong><p>Cumplimiento del ' + m.cumplimiento + '% con ' + m.tarde + ' pago(s) tardíos y un atraso máximo de ' + m.maxAtraso + ' días.' + (m.atrasoActual > 0 ? ' Ahora tiene ' + m.atrasoActual + ' día(s) de atraso.' : '') + '</p></div></div>';
        }
        return '<div class="advice advice-regular"><svg class="icon"><use href="#i-clock"/></svg><div><strong>Historial regular: renueva con precaución</strong><p>Cumplimiento del ' + m.cumplimiento + '%, con ' + m.tarde + ' pago(s) tardíos.' + (m.atrasoActual > 0 ? ' Actualmente debe ' + m.atrasoActual + ' día(s).' : '') + ' Revisa su caso antes de renovar.</p></div></div>';
    }

    function loanCardHTML(p) {
        var est = loanEstado(p);
        var st = loanStats(p);
        var chain = '';
        if (p.renovadoDe) {
            var old = getPrestamo(p.renovadoDe);
            if (old) chain = '<div class="loan-chain">Renovación de <button type="button" data-ver-prestamo="' + esc(old.id) + '">préstamo del ' + fmtFecha(old.fechaInicio) + '</button></div>';
        }
        if (p.renovadoPor) {
            var nuevo = getPrestamo(p.renovadoPor);
            if (nuevo) chain += '<div class="loan-chain">Renovado con <button type="button" data-ver-prestamo="' + esc(nuevo.id) + '">préstamo del ' + fmtFecha(nuevo.fechaInicio) + '</button></div>';
        }
        return '<article class="loan-card">' +
            '<div class="loan-top"><strong>' + money(p.monto) + '</strong><span class="badge ' + est.clase + '">' + est.label + '</span></div>' +
            '<div class="loan-meta">' + fmtFechaLarga(p.fechaInicio) + ' · ' + esc(p.modalidadNombre || '—') + ' · ' + pagosDePrestamo(p).length + ' pago(s)</div>' +
            '<div class="loan-data"><span>Total <b>' + money(st.total) + '</b></span><span>Pagado <b>' + money(st.pagado) + '</b></span><span>Saldo <b>' + money(st.saldo) + '</b></span></div>' +
            (p.estado === 'activo' && st.vencidos ? '<div class="loan-meta" style="color:#ff9d9d">' + st.vencidos + ' pago(s) vencido(s) por ' + money(st.vencidoMonto) + '</div>' : '') +
            chain +
            '<div class="loan-foot">' +
            '<button type="button" class="btn btn-outline" data-ver-prestamo="' + esc(p.id) + '">Ver pagos</button>' +
            ((p.estado === 'activo' || p.estado === 'liquidado') ? '<button type="button" class="btn btn-ghost" data-renovar="' + esc(p.id) + '"><svg class="icon"><use href="#i-refresh"/></svg> Renovar</button>' : '') +
            '</div></article>';
    }

    /* ================= Detalle del préstamo ================= */
    function renderPrestamo() {
        var p = getPrestamo(currentPrestamoId);
        if (!p) { navigate('deudores'); return; }
        var d = getDeudor(p.deudorId);
        var st = loanStats(p);
        var est = loanEstado(p);
        var editable = p.estado === 'activo' || (p.estado === 'liquidado' && !p.liquidacionAnticipada);
        var acciones = [];

        $('#prestamoHeader').innerHTML =
            '<div class="entity-head">' +
            '<div style="min-width:0">' +
            '<div class="entity-title"><h1>' + esc(d ? d.nombre : 'Deudor eliminado') + '</h1><span class="badge ' + est.clase + '">' + est.label + '</span></div>' +
            '<div class="entity-sub">' +
            '<span>Préstamo de ' + money(p.monto) + '</span>' +
            '<span>Inicio ' + fmtFechaLarga(p.fechaInicio) + '</span>' +
            '<span>' + esc(p.modalidadNombre || 'Sin modalidad') + '</span>' +
            '</div></div>' +
            '<div class="entity-actions">' +
            (p.estado === 'activo' ? '<button type="button" class="btn btn-ghost" data-editar-prestamo="' + esc(p.id) + '"><svg class="icon"><use href="#i-edit"/></svg> Editar</button>' : '') +
            '<button type="button" class="btn btn-ghost" data-compartir-prestamo="' + esc(p.id) + '"><svg class="icon"><use href="#i-share"/></svg> Compartir</button>' +
            '</div></div>';

        $('#prestamoResumen').innerHTML =
            statCard('money', 'blue', 'Monto del préstamo', money(p.monto), p.saldoArrastrado > 0 ? 'Incluye ' + money(p.saldoArrastrado) + ' anterior' : 'Entregado ' + money(p.montoEntregado || p.monto)) +
            statCard('receipt', '', 'Total a pagar', money(st.total), (Number(p.interes) || 0) + '% de interés') +
            statCard('check', '', 'Pagado', money(st.pagado), st.pagadosCount + ' de ' + st.pagosCount + ' pagos') +
            statCard('wallet', st.saldo > 0 ? 'amber' : 'green', 'Saldo', money(st.saldo), st.saldo > 0 ? 'Pendiente por cobrar' : 'Sin saldo pendiente') +
            statCard('calendar', 'blue', 'Próximo pago', st.proximo ? fmtFecha(st.proximo.fecha) : '—', st.proximo ? money(st.proximo.monto) : 'Sin pagos pendientes') +
            statCard('alert', st.vencidos > 0 ? 'red' : 'green', 'Atrasos', st.vencidos > 0 ? st.vencidos + ' pago(s)' : 'Ninguno', st.vencidos > 0 ? money(st.vencidoMonto) + ' vencido(s)' : 'Al corriente');

        if (p.estado === 'activo' && st.saldo > 0) {
            acciones.push('<button type="button" class="btn btn-pay" data-liquidar="' + esc(p.id) + '"><svg class="icon"><use href="#i-check"/></svg> Liquidar antes</button>');
        }
        if (p.estado === 'activo' || p.estado === 'liquidado') {
            acciones.push('<button type="button" class="btn btn-outline" data-renovar="' + esc(p.id) + '"><svg class="icon"><use href="#i-refresh"/></svg> Renovar</button>');
        }
        if (p.estado === 'liquidado' && !p.liquidacionAnticipada) {
            acciones.push('<button type="button" class="btn btn-ghost" data-reabrir="' + esc(p.id) + '"><svg class="icon"><use href="#i-history"/></svg> Reabrir</button>');
        }
        acciones.push('<button type="button" class="btn btn-ghost btn-danger" data-eliminar-prestamo="' + esc(p.id) + '"><svg class="icon"><use href="#i-trash"/></svg> Eliminar</button>');
        $('#prestamoAcciones').innerHTML = acciones.join('');

        var banner = '';
        if (p.liquidacionAnticipada) {
            banner = '<div class="settlement-banner"><svg class="icon"><use href="#i-check"/></svg><div><strong>Liquidado anticipadamente</strong><br>Recibido ' + money(p.montoLiquidado) + ' el ' + fmtFechaLarga(p.liquidadoEn) + '. Las cuotas pendientes quedan cerradas.</div></div>';
        }

        var rows = pagosDePrestamo(p).map(function (pay, i) {
            return paymentRowHTML(p, pay, i, editable);
        }).join('');

        $('#prestamoPagos').innerHTML =
            banner +
            '<div class="pay-block-head">' +
            '<h2>Calendario de pagos</h2>' +
            (p.estado === 'activo' ? '<button type="button" class="btn btn-sm btn-outline" data-add-pago="' + esc(p.id) + '"><svg class="icon"><use href="#i-plus"/></svg> Agregar pago</button>' : '') +
            '</div>' +
            (pagosDePrestamo(p).length ? '<div class="pay-list">' + rows + '</div>' : '<div class="empty-state">Este préstamo no tiene pagos registrados.</div>') +
            '<div class="pay-total"><span>Total del calendario</span><b>' + money(p.total) + '</b></div>' +
            '<p class="hint" style="margin-top:8px">Marca la casilla cuando el deudor pague. Puedes editar la fecha y el monto de cada pago; los cambios se guardan al salir del campo.</p>';
    }

    function paymentRowHTML(p, pay, i, editable) {
        var hoy = todayISO();
        var cerrado = p.liquidacionAnticipada && !pay.pagado;
        var vencido = !pay.pagado && !cerrado && pay.fecha < hoy;
        var dias = vencido ? Math.max(0, diffDays(hoy, pay.fecha)) : 0;
        var badge = pay.pagado
            ? '<span class="badge badge-ok">Pagado</span>'
            : cerrado
                ? '<span class="badge badge-gray">Cerrado</span>'
                : vencido
                    ? '<span class="badge badge-danger">Vencido ' + dias + 'd</span>'
                    : '<span class="badge badge-warn">Pendiente</span>';
        var dis = editable ? '' : ' disabled';
        return '<div class="pay-row ' + (pay.pagado ? 'is-paid' : '') + ' ' + (vencido ? 'is-late' : '') + '">' +
            '<div class="pay-top">' +
            '<label class="pay-check"><input type="checkbox" data-toggle-pay="' + i + '" ' + (pay.pagado ? 'checked' : '') + dis + '><span>Pago <span class="pay-num">' + pay.n + '</span></span></label>' +
            badge +
            (editable ? '<button type="button" class="icon-btn danger" data-del-pago="' + i + '" aria-label="Eliminar pago"><svg class="icon"><use href="#i-trash"/></svg></button>' : '') +
            '</div>' +
            '<div class="pay-fields">' +
            '<label class="pay-field"><span>Fecha</span><input type="date" data-pay-date="' + i + '" value="' + esc(pay.fecha) + '"' + dis + '></label>' +
            '<label class="pay-field"><span>Monto</span><input type="number" min="0" step="0.01" data-pay-monto="' + i + '" value="' + (Number(pay.monto) || 0) + '"' + dis + '></label>' +
            (pay.pagado ? '<label class="pay-field"><span>Pagado el</span><input type="date" data-pay-paid-date="' + i + '" value="' + esc(pay.fechaPago || '') + '"' + dis + '></label>' : '') +
            '</div></div>';
    }

    /* ================= Formulario de préstamo ================= */
    function plantillaOptionsHTML(selectedId) {
        return (db.modalidades || []).map(function (m) {
            return '<option value="' + esc(m.id) + '"' + (m.id === selectedId ? ' selected' : '') + '>' + esc(m.nombre) + '</option>';
        }).join('');
    }

    function refreshPlantillaSelect(selectedId) {
        var sel = $('#prestamoPlantilla');
        if (!sel) return;
        var current = selectedId || sel.value;
        if (!getPlantilla(current)) current = db.modalidades[0] ? db.modalidades[0].id : '';
        sel.innerHTML = plantillaOptionsHTML(current);
    }

    function applyPlantilla(id) {
        var m = getPlantilla(id);
        if (!m) return;
        $('#prestamoFrecuencia').value = m.frecuencia;
        $('#prestamoCadaDias').value = m.cadaDias || 15;
        $('#prestamoNumeroPagos').value = m.numeroPagos || 7;
        $('#prestamoInteres').value = m.interes || 0;
        $('#prestamoOmitirDomingo').checked = !!m.omitirDomingo;
        syncCadaDiasField();
        updateFormPreview();
    }

    function syncCadaDiasField() {
        $('#prestamoCadaDiasField').hidden = $('#prestamoFrecuencia').value !== 'personalizada';
    }

    function readModFromForm() {
        var frecuencia = $('#prestamoFrecuencia').value;
        var cadaDias = frecuencia === 'diaria' ? 1 : frecuencia === 'semanal' ? 7 : (parseInt($('#prestamoCadaDias').value, 10) || 1);
        return {
            frecuencia: frecuencia,
            cadaDias: cadaDias,
            numeroPagos: parseInt($('#prestamoNumeroPagos').value, 10) || 0,
            interes: Number($('#prestamoInteres').value) || 0,
            omitirDomingo: $('#prestamoOmitirDomingo').checked
        };
    }

    function modEsPersonalizada(mod) {
        var plantilla = getPlantilla($('#prestamoPlantilla').value);
        if (!plantilla) return true;
        return plantilla.frecuencia !== mod.frecuencia ||
            Number(plantilla.cadaDias) !== Number(mod.cadaDias) ||
            Number(plantilla.numeroPagos) !== Number(mod.numeroPagos) ||
            Number(plantilla.interes) !== Number(mod.interes) ||
            !!plantilla.omitirDomingo !== !!mod.omitirDomingo;
    }

    function modalidadNombreActual(mod) {
        var plantilla = getPlantilla($('#prestamoPlantilla').value);
        if (!plantilla) return 'Modalidad personalizada';
        return modEsPersonalizada(mod) ? plantilla.nombre + ' (personalizada)' : plantilla.nombre;
    }

    function renovacionActual() {
        if (formState.mode !== 'renovar') return null;
        var old = getPrestamo(formState.prestamoId);
        if (!old) return null;
        var st = loanStats(old);
        var radio = $('input[name="renovModo"]:checked');
        var sumar = radio && radio.value === 'sumar' && st.saldo > 0;
        return { old: old, saldo: st.saldo, sumar: !!sumar };
    }

    function openLoanForm(mode, opts) {
        opts = opts || {};
        formState = { mode: mode, deudorId: opts.deudorId || null, prestamoId: opts.prestamoId || null };
        fillLoanForm();
        navigate('form');
    }

    function fillLoanForm() {
        var mode = formState.mode;
        var d = formState.deudorId ? getDeudor(formState.deudorId) : null;
        var p = formState.prestamoId ? getPrestamo(formState.prestamoId) : null;
        if (mode !== 'nuevo' && p) d = getDeudor(p.deudorId);

        $('#formKicker').textContent = mode === 'editar' ? 'EDITAR' : mode === 'renovar' ? 'RENOVACIÓN' : 'NUEVO';
        $('#formTitulo').textContent = mode === 'editar' ? 'Editar préstamo' : mode === 'renovar' ? 'Renovar préstamo' : 'Nuevo préstamo';
        $('#btnGuardarPrestamo').innerHTML = '<svg class="icon"><use href="#i-check"/></svg> ' +
            (mode === 'editar' ? 'Guardar cambios' : mode === 'renovar' ? 'Guardar renovación' : 'Guardar préstamo');
        $('#montoLabel').textContent = mode === 'renovar' ? 'Monto nuevo (efectivo)' : 'Monto del préstamo';

        var sel = $('#prestamoDeudor');
        sel.innerHTML = '<option value="__nuevo__">+ Nuevo deudor</option>' + db.deudores.map(function (x) {
            return '<option value="' + esc(x.id) + '">' + esc(x.nombre) + '</option>';
        }).join('');

        $$('#formPrestamo .invalid').forEach(function (i) { i.classList.remove('invalid'); });

        if (mode === 'nuevo') {
            $('#formDeudorBlock').hidden = false;
            $('#renovacionBlock').hidden = true;
            sel.value = d ? d.id : '__nuevo__';
            $('#prestamoNombre').value = '';
            $('#prestamoTelefono').value = '';
            $('#prestamoMonto').value = '1000';
            $('#prestamoFecha').value = todayISO();
            refreshPlantillaSelect(db.modalidades[0] ? db.modalidades[0].id : null);
            applyPlantilla($('#prestamoPlantilla').value);
        } else {
            $('#formDeudorBlock').hidden = true;
            $('#deudorSeleccionadoInfo').hidden = false;
            $('#deudorSeleccionadoInfo').innerHTML = '<svg class="icon"><use href="#i-user"/></svg><div><strong>' + esc(d ? d.nombre : 'Deudor') + '</strong><br><span class="muted">' + esc(fmtTel(d ? d.telefono : '')) + '</span></div>';
            $('#prestamoNombre').value = '';
            $('#prestamoTelefono').value = '';

            var snap = (p && p.modalidadSnapshot) || { frecuencia: 'diaria', cadaDias: 1, numeroPagos: 7, interes: 20, omitirDomingo: true };
            var plantillaId = p && getPlantilla(p.modalidadId) ? p.modalidadId : (db.modalidades[0] ? db.modalidades[0].id : null);
            refreshPlantillaSelect(plantillaId);
            $('#prestamoFrecuencia').value = snap.frecuencia || 'diaria';
            $('#prestamoCadaDias').value = snap.cadaDias || 15;
            $('#prestamoNumeroPagos').value = snap.numeroPagos || 7;
            $('#prestamoInteres').value = snap.interes != null ? snap.interes : 20;
            $('#prestamoOmitirDomingo').checked = snap.omitirDomingo !== false;
            $('#prestamoFecha').value = mode === 'renovar' ? todayISO() : (p ? p.fechaInicio : todayISO());
            $('#prestamoMonto').value = p ? (mode === 'renovar' ? (p.montoEntregado || p.monto) : p.monto) : 1000;

            if (mode === 'renovar' && p) {
                var st = loanStats(p);
                $('#renovacionBlock').hidden = !(st.saldo > 0);
                $('#renovSaldo').textContent = money(st.saldo);
                var radios = $$('input[name="renovModo"]');
                if (radios[0]) radios[0].checked = true;
                updateRenovHint();
            } else {
                $('#renovacionBlock').hidden = true;
            }
        }

        syncDeudorFields();
        syncCadaDiasField();
        updateFormPreview();
    }

    function syncDeudorFields() {
        if (formState.mode !== 'nuevo') {
            $('#nuevoDeudorFields').hidden = true;
            return;
        }
        var esNuevo = $('#prestamoDeudor').value === '__nuevo__';
        $('#nuevoDeudorFields').hidden = !esNuevo;
        var chip = $('#deudorSeleccionadoInfo');
        if (esNuevo) {
            chip.hidden = true;
        } else {
            var d = getDeudor($('#prestamoDeudor').value);
            chip.hidden = !d;
            if (d) chip.innerHTML = '<svg class="icon"><use href="#i-user"/></svg><div><strong>' + esc(d.nombre) + '</strong><br><span class="muted">' + esc(fmtTel(d.telefono)) + '</span></div>';
        }
    }

    function updateRenovHint() {
        var info = renovacionActual();
        var hint = $('#renovHint');
        if (!hint) return;
        if (!info) { hint.textContent = ''; return; }
        var monto = Number($('#prestamoMonto').value) || 0;
        if (info.sumar) {
            hint.textContent = 'Se creará un préstamo con monto base de ' + money(monto + info.saldo) + ' (incluye ' + money(info.saldo) + ' del anterior). El préstamo anterior quedará marcado como renovado.';
        } else {
            hint.textContent = 'El préstamo anterior seguirá activo con su saldo actual. Se creará uno nuevo por ' + money(monto) + '.';
        }
    }

    function updateFormPreview() {
        var el = $('#formPreview');
        if (!el) return;
        var monto = Number($('#prestamoMonto').value) || 0;
        var fecha = $('#prestamoFecha').value;
        var mod = readModFromForm();
        var info = renovacionActual();
        var extra = info && info.sumar ? info.saldo : 0;
        var base = monto + extra;

        if (!monto || !fecha || !mod.numeroPagos) {
            el.innerHTML = '<div class="pv-note">Completa monto, fecha y número de pagos para ver el calendario.</div>';
            return;
        }

        var calc = buildSchedule(base, mod, fecha);
        var primero = calc.pagos[0];
        var ultimo = calc.pagos[calc.pagos.length - 1];
        var notas = [];
        if (extra > 0) notas.push('Incluye ' + money(extra) + ' del préstamo anterior (monto base ' + money(base) + ').');
        notas.push(mod.omitirDomingo ? 'Los domingos no se generan pagos: se recorren al lunes.' : 'Esta modalidad incluye pagos en domingo si corresponde.');
        if (formState.mode === 'editar') notas.push('Al guardar se recalculará el calendario y se conservarán los pagos marcados por número de pago.');

        el.innerHTML =
            '<div><div class="pv-label">Total a pagar</div><div class="pv-value green">' + money(calc.total) + '</div></div>' +
            '<div><div class="pv-label">Pago por cuota</div><div class="pv-value">' + money(primero.monto) + '</div></div>' +
            '<div><div class="pv-label">Número de pagos</div><div class="pv-value">' + calc.pagos.length + '</div></div>' +
            '<div><div class="pv-label">Primer pago</div><div class="pv-value">' + fmtFecha(primero.fecha) + '</div></div>' +
            '<div><div class="pv-label">Último pago</div><div class="pv-value">' + fmtFecha(ultimo.fecha) + '</div></div>' +
            '<div class="pv-note">' + notas.join(' ') + '</div>';
    }

    function validateLoanForm() {
        var errores = [];
        $$('#formPrestamo .invalid').forEach(function (i) { i.classList.remove('invalid'); });

        if (formState.mode === 'nuevo') {
            if ($('#prestamoDeudor').value === '__nuevo__') {
                if ($('#prestamoNombre').value.trim().length < 3) { errores.push('Escribe el nombre del deudor.'); $('#prestamoNombre').classList.add('invalid'); }
                var tel = normalizeTel($('#prestamoTelefono').value);
                if ($('#prestamoTelefono').value.trim() && tel.length !== 10) { errores.push('El WhatsApp debe tener 10 dígitos.'); $('#prestamoTelefono').classList.add('invalid'); }
            } else if (!getDeudor($('#prestamoDeudor').value)) {
                errores.push('Selecciona un deudor válido.');
            }
        }

        var monto = Number($('#prestamoMonto').value);
        if (!monto || monto < 100 || monto > 100000) { errores.push('El monto debe estar entre $100 y $100,000.'); $('#prestamoMonto').classList.add('invalid'); }
        if (!$('#prestamoFecha').value) { errores.push('Selecciona la fecha de entrega.'); $('#prestamoFecha').classList.add('invalid'); }

        var mod = readModFromForm();
        if (!mod.numeroPagos || mod.numeroPagos < 1 || mod.numeroPagos > 120) { errores.push('El número de pagos debe ser entre 1 y 120.'); $('#prestamoNumeroPagos').classList.add('invalid'); }
        if (mod.interes < 0 || mod.interes > 200) { errores.push('El interés debe estar entre 0 y 200%.'); $('#prestamoInteres').classList.add('invalid'); }
        if (mod.frecuencia === 'personalizada' && (!mod.cadaDias || mod.cadaDias < 1 || mod.cadaDias > 90)) { errores.push('Indica cada cuántos días se paga (1 a 90).'); $('#prestamoCadaDias').classList.add('invalid'); }

        return errores;
    }

    /* ================= Guardar préstamo ================= */
    var liquidarPrestamoId = null;

    function snapshotMod(mod) {
        return {
            frecuencia: mod.frecuencia,
            cadaDias: mod.cadaDias,
            numeroPagos: mod.numeroPagos,
            interes: mod.interes,
            omitirDomingo: mod.omitirDomingo
        };
    }

    function savePrestamo(ev) {
        if (ev) ev.preventDefault();
        var errores = validateLoanForm();
        if (errores.length) { toast(errores[0], 'error'); return; }

        var mod = readModFromForm();
        var monto = round2(Number($('#prestamoMonto').value));
        var fecha = $('#prestamoFecha').value;
        var plantilla = getPlantilla($('#prestamoPlantilla').value);
        var modNombre = modalidadNombreActual(mod);
        var modId = plantilla ? plantilla.id : null;
        var now = nowISO();

        if (formState.mode === 'nuevo') {
            var deudor;
            if ($('#prestamoDeudor').value === '__nuevo__') {
                deudor = {
                    id: uid(),
                    nombre: $('#prestamoNombre').value.trim(),
                    telefono: normalizeTel($('#prestamoTelefono').value),
                    notas: '',
                    creado: now,
                    actualizado: now
                };
                db.deudores.push(deudor);
            } else {
                deudor = getDeudor($('#prestamoDeudor').value);
            }
            if (!deudor) { toast('Selecciona un deudor válido.', 'error'); return; }

            var calc = buildSchedule(monto, mod, fecha);
            var nuevo = {
                id: uid(),
                deudorId: deudor.id,
                monto: monto,
                montoEntregado: monto,
                saldoArrastrado: 0,
                interes: mod.interes,
                total: calc.total,
                modalidadId: modId,
                modalidadNombre: modNombre,
                modalidadSnapshot: snapshotMod(mod),
                fechaInicio: fecha,
                pagos: calc.pagos,
                estado: 'activo',
                liquidadoEn: null,
                montoLiquidado: 0,
                liquidacionAnticipada: false,
                renovadoDe: null,
                renovadoPor: null,
                creado: now,
                actualizado: now
            };
            deudor.actualizado = now;
            db.prestamos.push(nuevo);
            if (!saveDB()) return;
            toast('Préstamo guardado.');
            navigate('prestamo', { prestamoId: nuevo.id });
            return;
        }

        if (formState.mode === 'editar') {
            var edit = getPrestamo(formState.prestamoId);
            if (!edit) { toast('No se encontró el préstamo.', 'error'); return; }
            var calcEdit = buildSchedule(monto, mod, fecha);
            var viejos = pagosDePrestamo(edit);
            edit.pagos = calcEdit.pagos.map(function (np) {
                var old = viejos.filter(function (x) { return Number(x.n) === Number(np.n); })[0];
                if (old && old.pagado) {
                    np.pagado = true;
                    np.fechaPago = old.fechaPago || np.fecha;
                }
                return np;
            });
            edit.monto = monto;
            edit.saldoArrastrado = Number(edit.saldoArrastrado) || 0;
            edit.montoEntregado = round2(Math.max(0, monto - edit.saldoArrastrado));
            edit.interes = mod.interes;
            edit.total = calcEdit.total;
            edit.modalidadId = modId;
            edit.modalidadNombre = modNombre;
            edit.modalidadSnapshot = snapshotMod(mod);
            edit.fechaInicio = fecha;
            edit.actualizado = now;
            var dEdit = getDeudor(edit.deudorId);
            if (dEdit) dEdit.actualizado = now;
            normalizeLoanState(edit);
            if (!saveDB()) return;
            toast('Cambios guardados.');
            navigate('prestamo', { prestamoId: edit.id });
            return;
        }

        if (formState.mode === 'renovar') {
            var old = getPrestamo(formState.prestamoId);
            if (!old) { toast('No se encontró el préstamo a renovar.', 'error'); return; }
            var st = loanStats(old);
            var radio = $('input[name="renovModo"]:checked');
            var sumar = radio && radio.value === 'sumar' && st.saldo > 0;
            var extra = sumar ? st.saldo : 0;
            var base = round2(monto + extra);
            var calcRen = buildSchedule(base, mod, fecha);
            var nuevoId = uid();
            var ren = {
                id: nuevoId,
                deudorId: old.deudorId,
                monto: base,
                montoEntregado: monto,
                saldoArrastrado: extra,
                interes: mod.interes,
                total: calcRen.total,
                modalidadId: modId,
                modalidadNombre: modNombre,
                modalidadSnapshot: snapshotMod(mod),
                fechaInicio: fecha,
                pagos: calcRen.pagos,
                estado: 'activo',
                liquidadoEn: null,
                montoLiquidado: 0,
                liquidacionAnticipada: false,
                renovadoDe: old.id,
                renovadoPor: null,
                creado: now,
                actualizado: now
            };
            db.prestamos.push(ren);
            if (sumar) {
                old.estado = 'renovado';
                old.renovadoPor = nuevoId;
                old.actualizado = now;
            }
            var dRen = getDeudor(old.deudorId);
            if (dRen) dRen.actualizado = now;
            if (!saveDB()) return;
            toast(sumar ? 'Préstamo renovado; saldo anterior sumado.' : 'Nuevo préstamo creado por separado.');
            navigate('prestamo', { prestamoId: nuevoId });
        }
    }

    /* ================= Pagos del préstamo ================= */
    function marcarPago(prestamoId, index, pagado) {
        var p = getPrestamo(prestamoId);
        if (!p) return false;
        var pay = pagosDePrestamo(p)[index];
        if (!pay) return false;
        pay.pagado = !!pagado;
        pay.fechaPago = pagado ? todayISO() : null;
        p.actualizado = nowISO();
        normalizeLoanState(p);
        return saveDB();
    }

    function handlePagoChange(ev) {
        var p = getPrestamo(currentPrestamoId);
        if (!p) return;
        var t = ev.target;
        var attr;

        attr = t.getAttribute('data-toggle-pay');
        if (attr != null) {
            marcarPago(p.id, Number(attr), t.checked);
            toast(t.checked ? 'Pago marcado como pagado.' : 'Pago marcado como pendiente.');
            renderPrestamo();
            return;
        }

        var pay;
        attr = t.getAttribute('data-pay-date');
        if (attr != null) {
            pay = pagosDePrestamo(p)[Number(attr)];
            if (!pay || !t.value) return;
            pay.fecha = t.value;
            p.actualizado = nowISO();
            normalizeLoanState(p);
            if (saveDB()) { renderPrestamo(); toast('Fecha del pago actualizada.'); }
            return;
        }

        attr = t.getAttribute('data-pay-monto');
        if (attr != null) {
            pay = pagosDePrestamo(p)[Number(attr)];
            if (!pay) return;
            pay.monto = round2(t.value);
            recomputeTotal(p);
            p.actualizado = nowISO();
            normalizeLoanState(p);
            if (saveDB()) { renderPrestamo(); toast('Monto del pago actualizado.'); }
            return;
        }

        attr = t.getAttribute('data-pay-paid-date');
        if (attr != null) {
            pay = pagosDePrestamo(p)[Number(attr)];
            if (!pay) return;
            pay.fechaPago = t.value || pay.fecha;
            p.actualizado = nowISO();
            if (saveDB()) { renderPrestamo(); toast('Fecha real de pago actualizada.'); }
        }
    }

    function handlePagoClick(ev) {
        var p = getPrestamo(currentPrestamoId);
        if (!p) return;

        var add = ev.target.closest('[data-add-pago]');
        if (add) {
            var pagos = pagosDePrestamo(p);
            var ultimo = pagos[pagos.length - 1];
            var montoNuevo = ultimo ? Number(ultimo.monto) || 0 : loanStats(p).saldo;
            pagos.push({ n: pagos.length + 1, fecha: todayISO(), monto: round2(montoNuevo), pagado: false, fechaPago: null });
            recomputeTotal(p);
            p.actualizado = nowISO();
            normalizeLoanState(p);
            if (saveDB()) { renderPrestamo(); toast('Pago agregado al calendario.'); }
            return;
        }

        var del = ev.target.closest('[data-del-pago]');
        if (del) {
            var i = Number(del.getAttribute('data-del-pago'));
            var lista = pagosDePrestamo(p);
            if (!lista[i]) return;
            if (!window.confirm('¿Eliminar el pago ' + lista[i].n + ' del calendario?')) return;
            lista.splice(i, 1);
            lista.forEach(function (x, idx) { x.n = idx + 1; });
            recomputeTotal(p);
            p.actualizado = nowISO();
            normalizeLoanState(p);
            if (saveDB()) { renderPrestamo(); toast('Pago eliminado.'); }
        }
    }

    function eliminarPrestamo(id) {
        var p = getPrestamo(id);
        if (!p) return;
        if (!window.confirm('¿Eliminar este préstamo y todo su historial de pagos? No se puede deshacer.')) return;

        if (p.renovadoDe) {
            var prev = getPrestamo(p.renovadoDe);
            if (prev) {
                if (prev.renovadoPor === id) prev.renovadoPor = null;
                if (prev.estado === 'renovado') prev.estado = 'activo';
                prev.actualizado = nowISO();
            }
        }
        if (p.renovadoPor) {
            var next = getPrestamo(p.renovadoPor);
            if (next && next.renovadoDe === id) next.renovadoDe = null;
        }
        db.prestamos = db.prestamos.filter(function (x) { return x.id !== id; });
        if (!saveDB()) return;
        toast('Préstamo eliminado.');
        navigate('deudor', { deudorId: p.deudorId });
    }

    function reabrirPrestamo(id) {
        var p = getPrestamo(id);
        if (!p || p.liquidacionAnticipada) return;
        if (!window.confirm('¿Reabrir este préstamo? Volverá a contar el saldo pendiente.')) return;
        p.estado = 'activo';
        p.liquidadoEn = null;
        p.montoLiquidado = 0;
        p.actualizado = nowISO();
        if (!saveDB()) return;
        toast('Préstamo reabierto.');
        navigate('prestamo', { prestamoId: id });
    }

    function openLiquidar(id) {
        var p = getPrestamo(id);
        if (!p) return;
        var st = loanStats(p);
        liquidarPrestamoId = p.id;
        $('#liquidarMonto').value = st.saldo > 0 ? st.saldo : 0;
        $('#liquidarFecha').value = todayISO();
        openModal($('#modalLiquidar'));
    }

    function saveLiquidacion(ev) {
        if (ev) ev.preventDefault();
        var p = getPrestamo(liquidarPrestamoId);
        if (!p) return;
        var monto = Number($('#liquidarMonto').value);
        var fecha = $('#liquidarFecha').value;
        if (!fecha || isNaN(monto) || monto < 0) { toast('Escribe un monto y una fecha válidos.', 'error'); return; }
        p.estado = 'liquidado';
        p.liquidadoEn = fecha;
        p.montoLiquidado = round2(monto);
        p.liquidacionAnticipada = true;
        p.actualizado = nowISO();
        var d = getDeudor(p.deudorId);
        if (d) d.actualizado = p.actualizado;
        if (!saveDB()) return;
        closeModal($('#modalLiquidar'));
        toast('Préstamo liquidado anticipadamente.');
        navigate('prestamo', { prestamoId: p.id });
    }

    /* ================= Modal de deudor ================= */
    function openDeudorModal(id) {
        editingDeudorId = id || null;
        var d = id ? getDeudor(id) : null;
        $('#modalDeudorTitulo').textContent = d ? 'Editar deudor' : 'Nuevo deudor';
        $('#deudorNombre').value = d ? d.nombre : '';
        $('#deudorTelefono').value = d ? d.telefono || '' : '';
        $('#deudorNotas').value = d ? d.notas || '' : '';
        $('#btnEliminarDeudor').hidden = !d;
        openModal($('#modalDeudor'));
    }

    function saveDeudor(ev) {
        if (ev) ev.preventDefault();
        var nombre = $('#deudorNombre').value.trim();
        var telRaw = $('#deudorTelefono').value.trim();
        var telefono = normalizeTel(telRaw);
        if (nombre.length < 3) { toast('Escribe el nombre completo.', 'error'); $('#deudorNombre').focus(); return; }
        if (telRaw && telefono.length !== 10) { toast('El WhatsApp debe tener 10 dígitos.', 'error'); $('#deudorTelefono').focus(); return; }

        var now = nowISO();
        if (editingDeudorId) {
            var d = getDeudor(editingDeudorId);
            if (!d) return;
            d.nombre = nombre;
            d.telefono = telefono;
            d.notas = $('#deudorNotas').value.trim();
            d.actualizado = now;
        } else {
            var nuevo = { id: uid(), nombre: nombre, telefono: telefono, notas: $('#deudorNotas').value.trim(), creado: now, actualizado: now };
            db.deudores.push(nuevo);
            editingDeudorId = nuevo.id;
        }
        if (!saveDB()) return;
        closeModal($('#modalDeudor'));
        toast('Datos del deudor guardados.');
        navigate('deudor', { deudorId: editingDeudorId });
    }

    function eliminarDeudor() {
        if (!editingDeudorId) return;
        var d = getDeudor(editingDeudorId);
        if (!d) return;
        if (!window.confirm('¿Eliminar a ' + d.nombre + ' junto con todos sus préstamos y pagos? No se puede deshacer.')) return;
        db.deudores = db.deudores.filter(function (x) { return x.id !== d.id; });
        db.prestamos = db.prestamos.filter(function (p) { return p.deudorId !== d.id; });
        if (!saveDB()) return;
        closeModal($('#modalDeudor'));
        currentDeudorId = null;
        toast('Deudor eliminado.');
        navigate('deudores');
    }

    function waDeudor(id) {
        var d = getDeudor(id);
        if (!d) return;
        window.open(waHref(d.telefono, 'Hola ' + d.nombre + ', te contacto de CREFÁCIL.'), '_blank', 'noopener');
    }

    /* ================= Plantillas ================= */
    function frecuenciaTexto(m) {
        var f = m.frecuencia === 'diaria' ? 'Diaria' : m.frecuencia === 'semanal' ? 'Semanal' : 'Cada ' + (m.cadaDias || 1) + ' días';
        return f + ' · ' + m.numeroPagos + ' pagos · ' + m.interes + '%' + (m.omitirDomingo ? ' · sin domingos' : '');
    }

    function renderPlantillas() {
        var cont = $('#listaPlantillas');
        if (!cont) return;
        cont.innerHTML = (db.modalidades || []).map(function (m) {
            return '<div class="modality-row">' +
                '<div class="m-info"><strong>' + esc(m.nombre) + '</strong><small>' + esc(frecuenciaTexto(m)) + '</small></div>' +
                '<button type="button" class="icon-btn" data-edit-plantilla="' + esc(m.id) + '" aria-label="Editar plantilla"><svg class="icon"><use href="#i-edit"/></svg></button>' +
                '<button type="button" class="icon-btn danger" data-del-plantilla="' + esc(m.id) + '" aria-label="Eliminar plantilla"><svg class="icon"><use href="#i-trash"/></svg></button>' +
                '</div>';
        }).join('');
    }

    function syncPlantillaCadaDias() {
        $('#plantillaCadaDiasField').hidden = $('#plantillaFrecuencia').value !== 'personalizada';
    }

    function resetPlantillaForm() {
        editingPlantillaId = null;
        $('#formPlantillaTitulo').textContent = 'Nueva plantilla';
        $('#plantillaNombre').value = '';
        $('#plantillaFrecuencia').value = 'diaria';
        $('#plantillaCadaDias').value = 15;
        $('#plantillaNumeroPagos').value = 7;
        $('#plantillaInteres').value = 20;
        $('#plantillaOmitirDomingo').checked = true;
        $('#btnCancelarPlantilla').hidden = true;
        syncPlantillaCadaDias();
        renderPlantillas();
    }

    function editPlantilla(id) {
        var m = getPlantilla(id);
        if (!m) return;
        editingPlantillaId = id;
        $('#formPlantillaTitulo').textContent = 'Editar plantilla';
        $('#plantillaNombre').value = m.nombre;
        $('#plantillaFrecuencia').value = m.frecuencia || 'diaria';
        $('#plantillaCadaDias').value = m.cadaDias || 15;
        $('#plantillaNumeroPagos').value = m.numeroPagos || 7;
        $('#plantillaInteres').value = m.interes || 0;
        $('#plantillaOmitirDomingo').checked = !!m.omitirDomingo;
        $('#btnCancelarPlantilla').hidden = false;
        syncPlantillaCadaDias();
        renderPlantillas();
        $('#plantillaNombre').focus();
    }

    function savePlantilla(ev) {
        if (ev) ev.preventDefault();
        var nombre = $('#plantillaNombre').value.trim();
        if (nombre.length < 2) { toast('Escribe un nombre para la plantilla.', 'error'); return; }
        var frecuencia = $('#plantillaFrecuencia').value;
        var cadaDias = frecuencia === 'diaria' ? 1 : frecuencia === 'semanal' ? 7 : (parseInt($('#plantillaCadaDias').value, 10) || 1);
        var numeroPagos = parseInt($('#plantillaNumeroPagos').value, 10) || 0;
        var interes = Number($('#plantillaInteres').value) || 0;
        if (numeroPagos < 1 || numeroPagos > 120) { toast('El número de pagos debe ser entre 1 y 120.', 'error'); return; }
        if (interes < 0 || interes > 200) { toast('El interés debe estar entre 0 y 200%.', 'error'); return; }
        if (frecuencia === 'personalizada' && (cadaDias < 1 || cadaDias > 90)) { toast('Indica cada cuántos días (1 a 90).', 'error'); return; }

        var datos = {
            nombre: nombre,
            frecuencia: frecuencia,
            cadaDias: cadaDias,
            numeroPagos: numeroPagos,
            interes: interes,
            omitirDomingo: $('#plantillaOmitirDomingo').checked
        };

        if (editingPlantillaId) {
            var m = getPlantilla(editingPlantillaId);
            if (!m) return;
            Object.assign(m, datos);
        } else {
            datos.id = uid();
            db.modalidades.push(datos);
        }
        if (!saveDB()) return;
        refreshPlantillaSelect($('#prestamoPlantilla') ? $('#prestamoPlantilla').value : null);
        resetPlantillaForm();
        toast('Plantilla guardada.');
    }

    function eliminarPlantilla(id) {
        var m = getPlantilla(id);
        if (!m) return;
        if (db.modalidades.length <= 1) { toast('Debe existir al menos una plantilla.', 'error'); return; }
        if (!window.confirm('¿Eliminar la plantilla "' + m.nombre + '"? Los préstamos ya guardados no cambian.')) return;
        db.modalidades = db.modalidades.filter(function (x) { return x.id !== id; });
        if (editingPlantillaId === id) resetPlantillaForm();
        if (!saveDB()) return;
        refreshPlantillaSelect($('#prestamoPlantilla') ? $('#prestamoPlantilla').value : null);
        renderPlantillas();
        toast('Plantilla eliminada.');
    }

    /* ================= Ajustes y respaldos ================= */
    function openAjustes() {
        resetPlantillaForm();
        openModal($('#modalAjustes'));
    }

    function descargarArchivo(nombre, contenido, tipo) {
        var blob = new Blob([contenido], { type: tipo || 'text/plain;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = nombre;
        document.body.appendChild(a);
        a.click();
        if (a.parentNode) a.parentNode.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    }

    function csvCell(v) {
        return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    }

    function exportarJSON() {
        descargarArchivo('crefacil-respaldo-' + todayISO() + '.json', JSON.stringify(db, null, 2), 'application/json;charset=utf-8');
        toast('Respaldo JSON descargado.');
    }

    function exportarCsvDeudores() {
        var lineas = [['Nombre', 'WhatsApp', 'Notas', 'Prestamos', 'Saldo', 'Calificacion', 'Atraso actual'].map(csvCell).join(',')];
        db.deudores.forEach(function (d) {
            var m = deudorMetrics(d.id);
            lineas.push([d.nombre, normalizeTel(d.telefono), d.notas || '', m.prestamos, m.saldo, CAL_LABEL[m.calificacion], m.atrasoActual].map(csvCell).join(','));
        });
        descargarArchivo('crefacil-deudores-' + todayISO() + '.csv', '\uFEFF' + lineas.join('\r\n'), 'text/csv;charset=utf-8');
        toast('CSV de deudores descargado.');
    }

    function exportarCsvPagos() {
        var lineas = [['Deudor', 'WhatsApp', 'Monto prestamo', 'Modalidad', 'Inicio', 'Pago', 'Fecha programada', 'Monto', 'Estado', 'Fecha pago', 'Liquidado antes', 'Monto liquidado', 'Fecha liquidacion'].map(csvCell).join(',')];
        var hoy = todayISO();
        db.prestamos.forEach(function (p) {
            var d = getDeudor(p.deudorId) || { nombre: 'Deudor eliminado', telefono: '' };
            pagosDePrestamo(p).forEach(function (pay) {
                var estado = pay.pagado ? 'Pagado' : (p.estado === 'activo' && pay.fecha < hoy ? 'Vencido' : 'Pendiente');
                lineas.push([
                    d.nombre, normalizeTel(d.telefono), p.monto, p.modalidadNombre || '', p.fechaInicio,
                    pay.n, pay.fecha, pay.monto, estado, pay.fechaPago || '',
                    p.liquidacionAnticipada ? 'Si' : 'No', p.montoLiquidado || '', p.liquidadoEn || ''
                ].map(csvCell).join(','));
            });
        });
        descargarArchivo('crefacil-pagos-' + todayISO() + '.csv', '\uFEFF' + lineas.join('\r\n'), 'text/csv;charset=utf-8');
        toast('CSV de pagos descargado.');
    }

    function importarRespaldo(file) {
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
            try {
                var data = JSON.parse(String(reader.result));
                var next = (data && Array.isArray(data.clientes) && !Array.isArray(data.deudores))
                    ? migrateLegacy(data)
                    : sanitizeDB(data);
                if (!window.confirm('Se reemplazarán los datos actuales por el respaldo: ' + next.deudores.length + ' deudor(es) y ' + next.prestamos.length + ' préstamo(s). ¿Continuar?')) return;
                db = next;
                if (!saveDB()) return;
                currentDeudorId = null;
                currentPrestamoId = null;
                closeModal($('#modalAjustes'));
                navigate('inicio');
                toast('Respaldo importado correctamente.');
            } catch (e) {
                toast('El archivo no es un respaldo válido.', 'error');
            }
        };
        reader.onerror = function () { toast('No se pudo leer el archivo.', 'error'); };
        reader.readAsText(file);
    }

    function borrarTodo() {
        if (!window.confirm('¿Borrar TODOS los deudores, préstamos y pagos de este dispositivo? Esta acción no se puede deshacer.')) return;
        db = seedDB();
        try { localStorage.removeItem(DB_KEY); } catch (e) { /* sin acceso */ }
        saveDB();
        currentDeudorId = null;
        currentPrestamoId = null;
        closeModal($('#modalAjustes'));
        navigate('inicio');
        toast('Todos los datos fueron eliminados.');
    }

    /* ================= Eventos ================= */
    function cancelarFormulario() {
        if (formState.mode !== 'nuevo' && formState.prestamoId) {
            navigate('prestamo', { prestamoId: formState.prestamoId });
            return;
        }
        if (formState.deudorId) {
            navigate('deudor', { deudorId: formState.deudorId });
            return;
        }
        navigate('deudores');
    }

    function handleGlobalClick(ev) {
        var t = ev.target;
        var btn;

        btn = t.closest('[data-close-modal]');
        if (btn) {
            var modal = btn.closest('.modal');
            if (modal) closeModal(modal);
            return;
        }

        btn = t.closest('[data-view]');
        if (btn) { navigate(btn.getAttribute('data-view')); return; }

        btn = t.closest('[data-nuevo]');
        if (btn) { openLoanForm('nuevo'); return; }

        btn = t.closest('[data-nuevo-deudor]');
        if (btn) { openLoanForm('nuevo', { deudorId: btn.getAttribute('data-nuevo-deudor') }); return; }

        btn = t.closest('[data-ver-deudor]');
        if (btn) { navigate('deudor', { deudorId: btn.getAttribute('data-ver-deudor') }); return; }

        btn = t.closest('[data-ver-prestamo]');
        if (btn) { navigate('prestamo', { prestamoId: btn.getAttribute('data-ver-prestamo') }); return; }

        btn = t.closest('[data-editar-deudor]');
        if (btn) { openDeudorModal(btn.getAttribute('data-editar-deudor')); return; }

        btn = t.closest('[data-wa-deudor]');
        if (btn) { waDeudor(btn.getAttribute('data-wa-deudor')); return; }

        btn = t.closest('[data-editar-prestamo]');
        if (btn) { openLoanForm('editar', { prestamoId: btn.getAttribute('data-editar-prestamo') }); return; }

        btn = t.closest('[data-renovar]');
        if (btn) { openLoanForm('renovar', { prestamoId: btn.getAttribute('data-renovar') }); return; }

        btn = t.closest('[data-liquidar]');
        if (btn) { openLiquidar(btn.getAttribute('data-liquidar')); return; }

        btn = t.closest('[data-reabrir]');
        if (btn) { reabrirPrestamo(btn.getAttribute('data-reabrir')); return; }

        btn = t.closest('[data-eliminar-prestamo]');
        if (btn) { eliminarPrestamo(btn.getAttribute('data-eliminar-prestamo')); return; }

        btn = t.closest('[data-compartir-prestamo]');
        if (btn) {
            var p = getPrestamo(btn.getAttribute('data-compartir-prestamo'));
            if (p) compartirPrestamo(p, getDeudor(p.deudorId));
            return;
        }

        btn = t.closest('[data-cobrar]');
        if (btn) {
            var partes = String(btn.getAttribute('data-cobrar')).split('|');
            if (marcarPago(partes[0], Number(partes[1]), true)) {
                toast('Pago registrado.');
                renderDashboard();
            }
            return;
        }

        btn = t.closest('[data-monto]');
        if (btn) {
            $('#prestamoMonto').value = btn.getAttribute('data-monto');
            updateFormPreview();
            return;
        }

        btn = t.closest('[data-edit-plantilla]');
        if (btn) { editPlantilla(btn.getAttribute('data-edit-plantilla')); return; }

        btn = t.closest('[data-del-plantilla]');
        if (btn) { eliminarPlantilla(btn.getAttribute('data-del-plantilla')); return; }

        btn = t.closest('#brandHome');
        if (btn) { navigate('inicio'); }
    }

    function actualizarConexion() {
        var bar = $('#offlineBar');
        if (!bar) return;
        var offline = !navigator.onLine;
        bar.hidden = !offline;
        document.body.classList.toggle('is-offline', offline);
        if (offline) document.documentElement.style.setProperty('--offline-h', bar.offsetHeight + 'px');
    }

    function bindEvents() {
        document.addEventListener('click', handleGlobalClick);
        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape') closeAllModals();
        });
        window.addEventListener('online', actualizarConexion);
        window.addEventListener('offline', actualizarConexion);
        window.addEventListener('resize', actualizarConexion);

        $('#formPrestamo').addEventListener('submit', savePrestamo);
        $('#formDeudor').addEventListener('submit', saveDeudor);
        $('#formLiquidar').addEventListener('submit', saveLiquidacion);
        $('#formPlantilla').addEventListener('submit', savePlantilla);

        $('#btnVolverDeudor').addEventListener('click', function () {
            navigate('deudor', { deudorId: currentDeudorId });
        });
        $('#btnCancelarForm').addEventListener('click', cancelarFormulario);
        $('#btnCancelarForm2').addEventListener('click', cancelarFormulario);
        $('#btnEliminarDeudor').addEventListener('click', eliminarDeudor);
        $('#btnCancelarPlantilla').addEventListener('click', resetPlantillaForm);

        $('#btnPlantillas').addEventListener('click', openAjustes);
        $('#btnRespaldo').addEventListener('click', openAjustes);
        $('#btnAjustesBottom').addEventListener('click', openAjustes);
        $('#btnExportJson').addEventListener('click', exportarJSON);
        $('#btnExportCsvDeudores').addEventListener('click', exportarCsvDeudores);
        $('#btnExportCsvPagos').addEventListener('click', exportarCsvPagos);
        $('#btnImportar').addEventListener('click', function () { $('#importarArchivo').click(); });
        $('#importarArchivo').addEventListener('change', function () {
            importarRespaldo(this.files && this.files[0]);
            this.value = '';
        });
        $('#btnBorrarTodo').addEventListener('click', borrarTodo);

        $('#prestamoDeudor').addEventListener('change', syncDeudorFields);
        $('#prestamoPlantilla').addEventListener('change', function () { applyPlantilla(this.value); });
        $('#prestamoFrecuencia').addEventListener('change', function () {
            syncCadaDiasField();
            updateFormPreview();
        });
        ['#prestamoMonto', '#prestamoNumeroPagos', '#prestamoInteres', '#prestamoCadaDias', '#prestamoFecha'].forEach(function (sel) {
            var el = $(sel);
            if (el) el.addEventListener('input', updateFormPreview);
        });
        $('#prestamoFecha').addEventListener('change', updateFormPreview);
        $('#prestamoOmitirDomingo').addEventListener('change', updateFormPreview);
        $$('input[name="renovModo"]').forEach(function (r) {
            r.addEventListener('change', function () {
                updateRenovHint();
                updateFormPreview();
            });
        });

        $('#plantillaFrecuencia').addEventListener('change', syncPlantillaCadaDias);

        $('#buscarDeudor').addEventListener('input', function () {
            searchDeudor = this.value;
            renderDeudores();
        });
        $('#filtroDeudor').addEventListener('change', function () {
            filtroDeudor = this.value;
            renderDeudores();
        });

        $('#prestamoPagos').addEventListener('change', handlePagoChange);
        $('#prestamoPagos').addEventListener('click', handlePagoClick);
    }

    function init() {
        db = loadDB();
        bindEvents();
        var anio = $('#anio');
        if (anio) anio.textContent = new Date().getFullYear();
        actualizarConexion();
        navigate('inicio');
        if (migrated) toast('Datos de la versión anterior importados.');
        if ('serviceWorker' in navigator && location.protocol !== 'file:') {
            navigator.serviceWorker.register('sw.js').catch(function () { /* offline no disponible */ });
        }
    }

    document.addEventListener('DOMContentLoaded', init);
})();
