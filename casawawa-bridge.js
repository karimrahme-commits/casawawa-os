/**
 * Casa Wawa Bridge
 * Conecta el dashboard con el API Server local (localhost:5555)
 * y permite enviar alertas al bot de Telegram.
 *
 * Este script se carga DESPUÉS del dashboard para poder
 * sobreescribir los métodos del objeto S.
 */

(function () {
  // Si se sirve desde el mismo server, usar origin; si no, fallback a localhost:5555
  const API = (window.location.port === "5555") ? "" : "http://localhost:5555";
  let bridgeActivo = false;

  // ─── Verificar conexión con el servidor ─────────────────────────────────
  fetch(`${API}/api/health`, { signal: AbortSignal.timeout(2000) })
    .then((r) => r.json())
    .then((d) => {
      if (d.ok) {
        bridgeActivo = true;
        console.log("[CasaWawa Bridge] ✅ Conectado al API Server");
        _sincronizarTodo();
        _mostrarIndicador(true);
      }
    })
    .catch(() => {
      console.warn("[CasaWawa Bridge] ⚠ API Server no disponible (corre api_server.py)");
      _mostrarIndicador(false);
    });

  // ─── Indicador visual en el topbar ──────────────────────────────────────
  function _mostrarIndicador(conectado) {
    const topbar = document.querySelector(".tb-r");
    if (!topbar) return;
    const el = document.createElement("div");
    el.id = "bridge-status";
    el.title = conectado ? "Karim Bot conectado" : "Karim Bot desconectado";
    el.style.cssText = `
      display:flex;align-items:center;gap:5px;font-size:10px;
      padding:3px 8px;border-radius:5px;cursor:pointer;
      background:${conectado ? "rgba(61,186,116,.1)" : "rgba(224,84,84,.1)"};
      color:${conectado ? "#3dba74" : "#e05454"};
      border:1px solid ${conectado ? "rgba(61,186,116,.2)" : "rgba(224,84,84,.2)"};
    `;
    el.innerHTML = `<span style="font-size:8px">●</span> Karim Bot ${conectado ? "ON" : "OFF"}`;
    if (conectado) {
      el.onclick = () => _enviarResumenManual();
    }
    topbar.insertBefore(el, topbar.firstChild);
  }

  // ─── Sincronización inicial: localStorage → API ──────────────────────────
  function _sincronizarTodo() {
    const CLAVES = [
      "ventas", "costos", "alertas", "tareas", "empleados", "turnos",
      "logE", "metas", "reportes", "historial", "pendientes", "clItems",
      "inventario", "invCats", "ordenes", "proveedores", "recetas",
      "mermas", "mesas", "reservas"
    ];
    CLAVES.forEach((k) => {
      const raw = localStorage.getItem("cw_" + k);
      if (raw !== null) {
        try {
          const val = JSON.parse(raw);
          _apiSet(k, val);
        } catch (_) {}
      }
    });
    console.log("[CasaWawa Bridge] Sincronización inicial completada");
  }

  // ─── Helpers de API ─────────────────────────────────────────────────────
  function _apiSet(key, value) {
    if (!bridgeActivo) return;
    fetch(`${API}/api/data/${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    }).catch(() => {});
  }

  // ─── Override de S.set y S.push ─────────────────────────────────────────
  // S es const pero sus propiedades son mutables
  if (typeof S !== "undefined") {
    const _origSet = S.set;
    S.set = function (k, v) {
      _origSet(k, v);
      _apiSet(k, v);
    };

    const _origPush = S.push;
    S.push = function (k, v, max) {
      const result = _origPush(k, v, max);
      _apiSet(k, S.get(k, []));

      // Auto-notificar alertas críticas al Telegram
      if (k === "alertas" && v && bridgeActivo) {
        const msg = v.texto || v.msg || v.titulo || JSON.stringify(v);
        const nivel = v.nivel || v.tipo || "info";
        const emoji = nivel === "critico" || nivel === "error" ? "🚨" : "⚠️";
        _notificar(`${emoji} <b>Alerta Casa Wawa</b>\n${msg}`);
      }

      return result;
    };

    console.log("[CasaWawa Bridge] S.set y S.push conectados a la API");
  }

  // ─── Función de notificación Telegram ───────────────────────────────────
  window.notificarKarim = function (mensaje, parseMode = "HTML") {
    if (!bridgeActivo) {
      console.warn("[Bridge] API no disponible para notificar");
      return;
    }
    fetch(`${API}/api/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: mensaje, parse_mode: parseMode }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          if (typeof toast === "function") toast("📱 Enviado a Karim Bot");
        } else {
          console.warn("[Bridge] Error al notificar:", d);
        }
      })
      .catch(() => console.warn("[Bridge] Sin conexión para notificar"));
  };

  function _notificar(msg) {
    window.notificarKarim(msg);
  }

  // ─── Resumen manual al hacer click en el indicador ──────────────────────
  function _enviarResumenManual() {
    fetch(`${API}/api/kpis`)
      .then((r) => r.json())
      .then((data) => {
        const ventas = data.ventas;
        const alertas = data.alertas;
        const tareas = data.tareas;

        let msg = "📊 <b>Resumen Casa Wawa</b>\n";

        if (ventas) {
          msg += `\n💰 <b>Ventas:</b> ${ventas.total || 0} registros`;
          if (ventas.ultimos && ventas.ultimos.length > 0) {
            const ult = ventas.ultimos[0];
            msg += `\nÚltima: $${ult.total || ult.monto || "–"}`;
          }
        }
        if (alertas) {
          msg += `\n🚨 <b>Alertas:</b> ${alertas.total || 0} pendientes`;
        }
        if (tareas) {
          msg += `\n✅ <b>Tareas:</b> ${tareas.total || 0} activas`;
        }

        _notificar(msg);
      })
      .catch(() => _notificar("📊 Resumen solicitado desde el dashboard"));
  }
})();
