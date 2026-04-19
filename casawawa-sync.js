/**
 * Casa Wawa Sync - WebSocket Real-Time Sync
 * Sincroniza datos entre todos los dispositivos conectados al server.
 * Se carga DESPUÉS del dashboard y del bridge.
 *
 * Flujo:
 *   S.set/push → localStorage → WebSocket → Server → otros dispositivos
 *   Server broadcast → WebSocket → localStorage → render()
 */

(function () {
  "use strict";

  // ═══════════════════════════════════════════════════════════════════════════
  // CONFIG
  // ═══════════════════════════════════════════════════════════════════════════

  // URL del server (mismo origin cuando se sirve desde el server)
  const SERVER_URL = window.location.origin;

  // Keys que se sincronizan
  const SYNC_KEYS = [
    "ventas", "costos", "alertas", "tareas", "clItems", "inventario",
    "empleados", "turnos", "mesas", "reservas", "dishes", "menuCats",
    "recetas", "ordenes", "proveedores", "mermas", "logE", "metas",
    "pendientes", "entradas", "cortes", "gastosTurno", "movInv",
    "users", "reportes", "historial", "preciosEntrada", "invCats",
    "checadas", "equiposTemp", "registrosTemp",
    "customRoles", "rolePins",
    "eventos",
    "rhExpedientes", "rhAreas", "rhIncidencias",
    "sysRolePerms",
  ];

  // Mapa: key → funciones render a llamar cuando llega un cambio remoto
  const RENDER_MAP = {
    ventas:          ["renderDash", "renderCaptura", "renderComp"],
    costos:          ["renderDash", "renderCostBars"],
    alertas:         ["renderDash"],
    tareas:          ["renderTareas", "renderDash"],
    clItems:         ["renderChecklists", "renderDash"],
    inventario:      ["renderInv", "renderDash", "renderTicker"],
    empleados:       ["renderCal", "renderAdmin"],
    turnos:          ["renderCal"],
    mesas:           ["renderMesas"],
    reservas:        ["renderMesas"],
    dishes:          ["renderMenu"],
    menuCats:        ["renderMenu"],
    recetas:         ["renderCosteo"],
    ordenes:         ["renderCompras"],
    proveedores:     ["renderCompras"],
    mermas:          ["renderMermas"],
    logE:            ["renderLog"],
    metas:           ["renderDash"],
    pendientes:      ["renderDash"],
    entradas:        ["renderCaja"],
    cortes:          ["renderCaja"],
    gastosTurno:     ["renderCaja"],
    users:           ["renderAdmin"],
    reportes:        ["renderCaptura"],
    historial:       [],
    invCats:         ["renderInv"],
    preciosEntrada:  ["renderCaja"],
    checadas:        ["renderChecadas", "renderDash", "renderNomina"],
    equiposTemp:     ["renderHACCP"],
    registrosTemp:   ["renderHACCP"],
    customRoles:     ["renderAdmin", "renderLoginRoles"],
    rolePins:        ["renderAdmin"],
    eventos:         ["renderEventos"],
    rhExpedientes:   ["renderRH"],
    rhAreas:         ["renderRH"],
    rhIncidencias:   ["renderRH"],
    sysRolePerms:    ["renderRolesList", "renderLoginRoles"],
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // ESTADO INTERNO
  // ═══════════════════════════════════════════════════════════════════════════

  let socket = null;
  let syncActivo = false;
  let _isRemoteUpdate = false;   // Guard contra loops infinitos
  let _renderTimers = {};        // Debounce de renders
  let _deviceId = _getDeviceId();
  let _totalDevices = 1;
  let _initialSyncDone = false;

  // ═══════════════════════════════════════════════════════════════════════════
  // INICIALIZACIÓN
  // ═══════════════════════════════════════════════════════════════════════════

  function init() {
    // Verificar que Socket.IO client esté cargado
    if (typeof io === "undefined") {
      console.warn("[Sync] Socket.IO client no cargado");
      _mostrarEstado("off", 1);
      return;
    }

    // Verificar que el objeto S existe
    if (typeof S === "undefined") {
      console.warn("[Sync] Objeto S no encontrado");
      return;
    }

    // Conectar WebSocket
    _conectar();

    // Override de S.set y S.push
    _overrideStorage();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONEXIÓN WEBSOCKET
  // ═══════════════════════════════════════════════════════════════════════════

  function _conectar() {
    try {
      socket = io(SERVER_URL + "/sync", {
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 10000,
      });

      // ─── Eventos de conexión ────────────────────────────────────────

      socket.on("connect", () => {
        console.log("[Sync] ✅ Conectado al server");
        syncActivo = true;

        // Registrar este dispositivo
        socket.emit("register_device", {
          device_id: _deviceId,
          role: typeof CR !== "undefined" ? CR : "unknown",
          name: _getDeviceName(),
        });

        // Pedir sync completo si es la primera vez
        if (!_initialSyncDone) {
          socket.emit("request_full_sync");
        }

        _mostrarEstado("on", _totalDevices);
      });

      socket.on("disconnect", () => {
        console.log("[Sync] ⚠️ Desconectado");
        syncActivo = false;
        _mostrarEstado("offline", _totalDevices);
      });

      socket.on("connect_error", (err) => {
        console.warn("[Sync] Error de conexión:", err.message);
        syncActivo = false;
        _mostrarEstado("offline", _totalDevices);
      });

      // ─── Eventos de sync ────────────────────────────────────────────

      socket.on("sync_status", (data) => {
        _totalDevices = data.total_devices || 1;
        _mostrarEstado("on", _totalDevices);
      });

      socket.on("device_count", (data) => {
        _totalDevices = data.total || 1;
        _mostrarEstado(syncActivo ? "on" : "offline", _totalDevices);
        console.log(`[Sync] 📱 Dispositivos conectados: ${_totalDevices}`);
      });

      // Recibir cambio de OTRO dispositivo
      socket.on("data_update", (data) => {
        const { key, value, source } = data;

        // Ignorar nuestros propios cambios
        if (source === _deviceId) return;

        // No sincronizar keys que no están en la lista
        if (!SYNC_KEYS.includes(key)) return;

        console.log(`[Sync] 📥 ${key} actualizado por otro dispositivo`);

        // Aplicar localmente sin re-enviar al server
        _isRemoteUpdate = true;
        S.set(key, value);
        _isRemoteUpdate = false;

        // Render con debounce
        _debouncedRender(key);

        // Visual feedback silenciado — solo log en consola
        console.log(`[Sync] 🔄 ${_keyLabel(key)} sincronizado`);
      });

      // Recibir sync completo (primera conexión)
      socket.on("full_sync_response", (data) => {
        const serverData = data.data || {};
        let updated = 0;

        _isRemoteUpdate = true;

        Object.entries(serverData).forEach(([key, value]) => {
          if (!SYNC_KEYS.includes(key)) return;

          const localValue = S.get(key, null);
          const localJson = JSON.stringify(localValue);
          const remoteJson = JSON.stringify(value);

          // Si el server tiene datos y son diferentes, usar los del server
          if (value !== null && localJson !== remoteJson) {
            S.set(key, value);
            updated++;
          }

          // Si solo existe local, subir al server
          if (localValue !== null && value === null) {
            socket.emit("data_sync", {
              key: key,
              value: localValue,
              device_id: _deviceId,
              ts: Date.now(),
            });
          }
        });

        // Subir keys locales que no existen en el server
        SYNC_KEYS.forEach((key) => {
          if (!(key in serverData)) {
            const localValue = S.get(key, null);
            if (localValue !== null) {
              socket.emit("data_sync", {
                key: key,
                value: localValue,
                device_id: _deviceId,
                ts: Date.now(),
              });
              updated++;
            }
          }
        });

        _isRemoteUpdate = false;
        _initialSyncDone = true;

        if (updated > 0) {
          console.log(`[Sync] ✅ Full sync: ${updated} keys actualizadas`);
          // Re-render todo
          _renderAll();
          // Toast silenciado — solo log en consola
          console.log(`[Sync] ✅ Sincronizado (${updated} datos)`);
        } else {
          console.log("[Sync] ✅ Full sync: todo al día");
        }
      });

    } catch (err) {
      console.error("[Sync] Error al conectar:", err);
      _mostrarEstado("error", 1);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OVERRIDE DE S.set / S.push
  // ═══════════════════════════════════════════════════════════════════════════

  function _overrideStorage() {
    const _prevSet = S.set;
    const _prevPush = S.push;

    S.set = function (k, v) {
      // Siempre escribir local (localStorage + bridge API)
      _prevSet(k, v);

      // Si es un update remoto, NO re-enviar al server
      if (_isRemoteUpdate) return;

      // Enviar al server vía WebSocket
      if (syncActivo && socket && SYNC_KEYS.includes(k)) {
        socket.emit("data_sync", {
          key: k,
          value: v,
          device_id: _deviceId,
          ts: Date.now(),
        });
      }
    };

    S.push = function (k, v, max) {
      // Ejecutar push local
      const result = _prevPush(k, v, max);

      // Si es remoto, no re-enviar
      if (_isRemoteUpdate) return result;

      // Enviar el array completo al server
      if (syncActivo && socket && SYNC_KEYS.includes(k)) {
        const fullArray = S.get(k, []);
        socket.emit("data_sync", {
          key: k,
          value: fullArray,
          device_id: _deviceId,
          ts: Date.now(),
        });
      }

      return result;
    };

    console.log("[Sync] S.set y S.push conectados a WebSocket");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════════

  function _debouncedRender(key) {
    const fns = RENDER_MAP[key];
    if (!fns || fns.length === 0) return;

    if (_renderTimers[key]) {
      clearTimeout(_renderTimers[key]);
    }

    _renderTimers[key] = setTimeout(() => {
      fns.forEach((fnName) => {
        if (typeof window[fnName] === "function") {
          try {
            window[fnName]();
          } catch (err) {
            // Silenciar — puede que la página no esté visible
          }
        }
      });
    }, 300);
  }

  function _renderAll() {
    // Pequeño delay para que localStorage se actualice
    setTimeout(() => {
      const allFns = new Set();
      Object.values(RENDER_MAP).forEach((fns) =>
        fns.forEach((fn) => allFns.add(fn))
      );
      allFns.forEach((fnName) => {
        if (typeof window[fnName] === "function") {
          try {
            window[fnName]();
          } catch (e) {}
        }
      });
    }, 100);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INDICADOR VISUAL
  // ═══════════════════════════════════════════════════════════════════════════

  function _mostrarEstado(estado, deviceCount) {
    const prev = document.getElementById("sync-status");
    if (prev) prev.remove();

    const topbar = document.querySelector(".tb-r");
    if (!topbar) return;

    const configs = {
      on:      { bg: "rgba(61,186,116,.1)",  color: "#3dba74", border: "rgba(61,186,116,.2)", icon: "●" },
      offline: { bg: "rgba(224,168,50,.1)",   color: "#e0a832", border: "rgba(224,168,50,.2)", icon: "○" },
      off:     { bg: "rgba(136,136,160,.08)", color: "#8888a0", border: "rgba(136,136,160,.15)", icon: "○" },
      error:   { bg: "rgba(224,84,84,.1)",    color: "#e05454", border: "rgba(224,84,84,.2)", icon: "✕" },
    };

    const c = configs[estado] || configs.off;
    const count = deviceCount || 1;
    const label = estado === "on"
      ? `${count} ${count === 1 ? "dispositivo" : "dispositivos"}`
      : estado === "offline"
        ? "Sin conexión"
        : "Sync OFF";

    const el = document.createElement("div");
    el.id = "sync-status";
    el.style.cssText = `
      display:flex;align-items:center;gap:5px;font-size:10px;
      padding:3px 9px;border-radius:5px;cursor:pointer;
      background:${c.bg};color:${c.color};border:1px solid ${c.border};
      margin-right:4px;transition:all .2s;
    `;
    el.innerHTML = `<span style="font-size:7px">${c.icon}</span> ${label}`;

    el.onclick = () => {
      const info = `Sync: ${estado.toUpperCase()}\n`
        + `Dispositivos: ${count}\n`
        + `Device ID: ${_deviceId.slice(0, 12)}...\n`
        + `Server: ${SERVER_URL}`;
      if (typeof toast === "function") {
        toast(info.replace(/\n/g, " | "));
      } else {
        alert(info);
      }
    };

    // Insertar al principio del topbar
    topbar.insertBefore(el, topbar.firstChild);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UTILIDADES
  // ═══════════════════════════════════════════════════════════════════════════

  function _getDeviceId() {
    let id = localStorage.getItem("cw_deviceId");
    if (!id) {
      id = "dev_" + Math.random().toString(36).substr(2, 8)
         + "_" + Date.now().toString(36);
      localStorage.setItem("cw_deviceId", id);
    }
    return id;
  }

  function _getDeviceName() {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return "iPhone";
    if (/iPad/.test(ua)) return "iPad";
    if (/Android/.test(ua)) return "Android";
    if (/Mac/.test(ua)) return "Mac";
    if (/Windows/.test(ua)) return "Windows";
    return "Navegador";
  }

  function _keyLabel(key) {
    const labels = {
      ventas: "Ventas", alertas: "Alertas", tareas: "Tareas",
      inventario: "Inventario", empleados: "Empleados", mesas: "Mesas",
      dishes: "Menú", recetas: "Recetas", mermas: "Mermas",
      clItems: "Checklists", ordenes: "Compras", reservas: "Reservas",
      entradas: "Entradas", cortes: "Cortes", metas: "Metas",
      checadas: "Checadas", equiposTemp: "Equipos HACCP", registrosTemp: "Temperaturas",
      customRoles: "Puestos",
    };
    return labels[key] || key;
  }

  // Exponer estado para debug
  window.syncStatus = function () {
    return {
      activo: syncActivo,
      dispositivos: _totalDevices,
      deviceId: _deviceId,
      initialSync: _initialSyncDone,
    };
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // ARRANCAR
  // ═══════════════════════════════════════════════════════════════════════════

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(init, 800));
  } else {
    setTimeout(init, 800);
  }
})();
