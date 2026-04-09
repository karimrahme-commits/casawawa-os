"""
Casa Wawa OS — Servidor Backend
Flask + Socket.IO + almacenamiento en memoria (seed desde JSON)
Compatible con Railway, Render y cualquier plataforma PaaS.
"""
import json, os, threading, requests as req_lib
from datetime import datetime
from flask import Flask, request, jsonify, send_from_directory
from flask_socketio import SocketIO, emit
from flask_cors import CORS

# ─── Configuración de Telegram ────────────────────────────────────────────────
TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN", "8686503680:AAFLLAnoePMLniCYxc_kliSQf81bo_lLH40")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "8190295136")

def _send_telegram(message, parse_mode="HTML"):
    """Envía un mensaje al bot de Telegram de Karim."""
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        return False, "Token o chat_id no configurado"
    try:
        url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
        payload = {
            "chat_id": TELEGRAM_CHAT_ID,
            "text": message,
            "parse_mode": parse_mode
        }
        r = req_lib.post(url, json=payload, timeout=10)
        data = r.json()
        if data.get("ok"):
            return True, "Enviado"
        else:
            return False, data.get("description", "Error desconocido")
    except Exception as e:
        return False, str(e)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(BASE_DIR, "data", "seed.json")

app = Flask(__name__, static_folder=BASE_DIR, static_url_path="")
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "casawawa-secret-2026")
CORS(app, resources={r"/*": {"origins": "*"}})
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet",
                    path="/socket.io", logger=False, engineio_logger=False)

# ─── Almacenamiento en memoria ────────────────────────────────────────────────
_lock = threading.Lock()
_store = {}
_devices = {}

def _load_seed():
    global _store
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        for k, v in data.items():
            if v is not None:
                _store[k] = v
        print(f"[CasaWawa] Datos cargados desde seed.json ({len(_store)} claves)")
    else:
        print("[CasaWawa] Sin seed.json — iniciando vacío")

def _save_data():
    try:
        os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)
        with open(DATA_FILE, "w", encoding="utf-8") as f:
            json.dump(_store, f, ensure_ascii=False)
    except Exception as e:
        print(f"[CasaWawa] Error guardando datos: {e}")

# ─── Rutas estáticas ──────────────────────────────────────────────────────────
@app.route("/")
def index():
    return send_from_directory(BASE_DIR, "index.html")

@app.route("/casawawa-bridge.js")
def bridge():
    return send_from_directory(BASE_DIR, "casawawa-bridge.js")

@app.route("/casawawa-sync.js")
def sync_js():
    return send_from_directory(BASE_DIR, "casawawa-sync.js")

@app.route("/manifest.json")
def manifest():
    return send_from_directory(BASE_DIR, "manifest.json")

@app.route("/icons/<path:filename>")
def icons(filename):
    return send_from_directory(os.path.join(BASE_DIR, "icons"), filename)

# ─── API REST ─────────────────────────────────────────────────────────────────
@app.route("/api/health")
def health():
    return jsonify({"ok": True, "servicio": "Casa Wawa OS",
                    "version": "4.0", "sync": "websocket",
                    "dispositivos": len(_devices)})

@app.route("/api/config")
def config():
    return jsonify({"biz": _store.get("_bizName", "Casa Wawa"),
                    "telegram": False})

@app.route("/api/kpis")
def kpis():
    return jsonify({
        "ventas":    {"total": len(_store.get("ventas", []) or []),
                      "ultimos": (_store.get("ventas") or [])[:3]},
        "alertas":   {"total": len(_store.get("alertas", []) or [])},
        "tareas":    {"total": len(_store.get("tareas", []) or [])},
        "inventario":{"total": len(_store.get("inventario", []) or [])},
        "mesas":     {"total": len(_store.get("mesas", []) or [])},
        "pendientes":{"total": len(_store.get("pendientes", []) or [])},
        "reservas":  {"total": len(_store.get("reservas", []) or [])},
        "turnos":    {"total": len(_store.get("turnos", []) or []),
                      "ultimos": (_store.get("turnos") or [])[:3]},
    })

@app.route("/api/data/<key>", methods=["GET"])
def get_data(key):
    with _lock:
        return jsonify(_store.get(key))

@app.route("/api/data/<key>", methods=["POST"])
def set_data(key):
    value = request.get_json(force=True, silent=True)
    with _lock:
        _store[key] = value
    threading.Thread(target=_save_data, daemon=True).start()
    socketio.emit("data_update", {
        "key": key, "value": value,
        "source": request.headers.get("X-Device-Id", "api"),
        "ts": int(datetime.now().timestamp() * 1000)
    }, namespace="/sync")
    return jsonify({"ok": True})

@app.route("/api/notify", methods=["POST"])
def notify():
    data = request.get_json(force=True, silent=True) or {}
    message = data.get("message", "").strip()
    parse_mode = data.get("parse_mode", "HTML")
    if not message:
        return jsonify({"ok": False, "error": "Mensaje vacío"}), 400
    ok, detail = _send_telegram(message, parse_mode)
    if ok:
        print(f"[Telegram] ✅ Enviado: {message[:60]}...")
        return jsonify({"ok": True, "msg": "Enviado a Karim"})
    else:
        print(f"[Telegram] ❌ Error: {detail}")
        return jsonify({"ok": False, "error": detail}), 500

@app.route("/api/notify/test", methods=["GET"])
def notify_test():
    ok, detail = _send_telegram(
        "👋 <b>Casa Wawa OS</b>\n\nConexión con Telegram verificada correctamente.\n✅ El bot está activo y listo.",
        "HTML"
    )
    return jsonify({"ok": ok, "detail": detail})

@app.route("/api/reporte-cierre", methods=["POST"])
def reporte_cierre():
    ventas = _store.get("ventas") or []
    hoy = datetime.now().strftime("%Y-%m-%d")
    ventas_hoy = [v for v in ventas if v.get("fecha") == hoy]
    total = sum(float(v.get("ventas", 0)) for v in ventas_hoy)
    comensales = sum(int(v.get("comensales", 0)) for v in ventas_hoy)
    ticket = f"${total/comensales:.0f}" if comensales else "—"
    reporte = (
        f"📊 <b>REPORTE DE CIERRE</b> — {hoy}\n\n"
        f"💰 Ventas: <b>${total:,.0f}</b>\n"
        f"👥 Comensales: {comensales}\n"
        f"🎫 Ticket Prom: {ticket}"
    )
    # Enviar por Telegram
    threading.Thread(target=_send_telegram, args=(reporte, "HTML"), daemon=True).start()
    return jsonify({"ok": True, "reporte": reporte})

@app.route("/api/nomina")
def nomina():
    periodo = request.args.get("periodo", "semanal")
    checadas = _store.get("checadas") or []
    empleados = _store.get("empleados") or []
    emp_map = {e["id"]: e for e in empleados}
    emp_horas = {}
    for c in checadas:
        eid = c.get("empId")
        if not eid:
            continue
        if eid not in emp_horas:
            emp_horas[eid] = {"horas": 0, "dias": set(), "nombre": c.get("empNombre", eid)}
        emp_horas[eid]["horas"] += float(c.get("horas", 0) or 0)
        if c.get("fecha"):
            emp_horas[eid]["dias"].add(c["fecha"])
    result = []
    total_horas = 0
    total_sueldo = 0
    for eid, data in emp_horas.items():
        emp = emp_map.get(eid, {})
        sueldo_hr = float(emp.get("sueldoHr", 0) or 0)
        horas = round(data["horas"], 1)
        sueldo = round(horas * sueldo_hr, 2)
        total_horas += horas
        total_sueldo += sueldo
        result.append({
            "id": eid, "nombre": data["nombre"],
            "diasTrabajados": len(data["dias"]),
            "horasTotal": horas, "horasExtra": 0,
            "sueldoHr": sueldo_hr, "sueldoTotal": sueldo
        })
    hoy = datetime.now().strftime("%Y-%m-%d")
    return jsonify({
        "empleados": result,
        "totalHoras": round(total_horas, 1),
        "totalSueldo": round(total_sueldo, 2),
        "dias": 7 if periodo == "semanal" else 15,
        "inicio": hoy, "fin": hoy
    })

@app.route("/api/karim/chat", methods=["POST"])
def karim_chat():
    body = request.get_json(force=True, silent=True) or {}
    messages = body.get("messages", [])
    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        return jsonify({"ok": False, "reply": "API key no configurada.",
                       "content": [{"type": "text", "text": "API key no configurada."}]})
    try:
        from openai import OpenAI
        client = OpenAI(api_key=api_key)
        ventas = _store.get("ventas") or []
        inventario = _store.get("inventario") or []
        alertas = _store.get("alertas") or []
        tareas = _store.get("tareas") or []
        hoy = datetime.now().strftime("%Y-%m-%d")
        ventas_hoy = [v for v in ventas if v.get("fecha") == hoy]
        total_hoy = sum(float(v.get("ventas", 0)) for v in ventas_hoy)
        low_inv = [i for i in inventario if float(i.get("stock", 0)) <= float(i.get("stockMin", 0))]
        system_msg = (
            f"Eres Super Karim, el asistente IA del restaurante Casa Wawa. "
            f"Responde siempre en español, de forma directa y práctica.\n\n"
            f"DATOS HOY ({hoy}):\n"
            f"- Ventas: ${total_hoy:,.0f}\n"
            f"- Artículos bajo stock: {len(low_inv)}\n"
            f"- Alertas activas: {len(alertas)}\n"
            f"- Tareas pendientes: {len([t for t in tareas if t.get('estado') != 'listo'])}"
        )
        all_messages = [{"role": "system", "content": system_msg}] + messages
        response = client.chat.completions.create(
            model="gpt-4.1-mini", messages=all_messages, max_tokens=500
        )
        reply = response.choices[0].message.content
        return jsonify({"ok": True, "reply": reply,
                       "content": [{"type": "text", "text": reply}]})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e),
                       "reply": f"Error: {e}",
                       "content": [{"type": "text", "text": f"Error: {e}"}]})

@app.route("/api/karim/clear", methods=["POST"])
def karim_clear():
    return jsonify({"ok": True})

@app.route("/api/karim/memory", methods=["GET", "POST", "DELETE"])
def karim_memory():
    if request.method == "GET":
        return jsonify(_store.get("_karim_memory", []))
    elif request.method == "POST":
        mem = request.get_json(force=True, silent=True) or {}
        memories = _store.get("_karim_memory", [])
        memories.append(mem)
        _store["_karim_memory"] = memories
        return jsonify({"ok": True})
    else:
        _store["_karim_memory"] = []
        return jsonify({"ok": True})

# ─── WebSocket ────────────────────────────────────────────────────────────────
@socketio.on("connect", namespace="/sync")
def on_connect():
    print(f"[Sync] Conectado: {request.sid}")

@socketio.on("disconnect", namespace="/sync")
def on_disconnect():
    sid = request.sid
    _devices.pop(sid, None)
    socketio.emit("device_count", {"total": len(_devices)}, namespace="/sync")

@socketio.on("register_device", namespace="/sync")
def on_register(data):
    sid = request.sid
    _devices[sid] = {
        "device_id": data.get("device_id", sid),
        "role": data.get("role", "unknown"),
        "name": data.get("name", "Dispositivo"),
    }
    emit("sync_status", {"total_devices": len(_devices), "ok": True})
    socketio.emit("device_count", {"total": len(_devices)}, namespace="/sync")

@socketio.on("request_full_sync", namespace="/sync")
def on_full_sync():
    with _lock:
        emit("full_sync_response", {"data": _store, "ok": True})

@socketio.on("data_sync", namespace="/sync")
def on_data_sync(data):
    key = data.get("key")
    value = data.get("value")
    device_id = data.get("device_id", request.sid)
    if not key:
        return
    with _lock:
        _store[key] = value
    threading.Thread(target=_save_data, daemon=True).start()
    socketio.emit("data_update", {
        "key": key, "value": value,
        "source": device_id,
        "ts": int(datetime.now().timestamp() * 1000)
    }, namespace="/sync", skip_sid=request.sid)

# ─── Sincronización con Wawa Calendar ────────────────────────────────────
WAWA_CALENDAR_URL = os.environ.get("WAWA_CALENDAR_URL", "https://wawacalend-sfzuhfo8.manus.space")

def _fetch_wawa_calendar_events():
    """Extrae eventos del Wawa Calendar via scraping del bundle JS."""
    try:
        import re
        # Obtener el HTML para encontrar el bundle JS
        r = req_lib.get(WAWA_CALENDAR_URL, timeout=15)
        js_match = re.search(r'src="(/assets/index-[^"]+\.js)"', r.text)
        if not js_match:
            return None, "No se encontró el bundle JS"
        js_url = WAWA_CALENDAR_URL + js_match.group(1)
        rjs = req_lib.get(js_url, timeout=30)
        content = rjs.text

        tipo_map = {
            'actividad': 'actividad', 'show': 'show', 'taller': 'taller',
            'fiesta': 'fiesta', 'especial': 'actividad', 'clase': 'taller',
        }

        eventos = []
        seen_ids = set()

        def add_ev(id_, nombre, tipo, fecha, h_ini, h_fin, estado, desc='', edad='', semana='', precio=0, cap=0):
            if id_ in seen_ids:
                return
            seen_ids.add(id_)
            notas_parts = []
            if semana: notas_parts.append(f"Semana: {semana}")
            if edad: notas_parts.append(f"Edad: {edad}")
            if precio: notas_parts.append(f"Precio: ${precio}/niño")
            if cap: notas_parts.append(f"Capacidad: {cap} personas")
            eventos.append({
                'id': id_, 'nombre': nombre,
                'categoria': tipo_map.get(tipo, 'actividad'),
                'fecha': fecha,
                'hora': h_ini or '11:00',
                'horaFin': h_fin or '20:00',
                'descripcion': desc or '',
                'asistencia': int(cap) if cap else 0,
                'responsable': 'Casa Wawa',
                'notas': ' | '.join(notas_parts),
                'estado': estado or 'confirmado',
                'ts': int(datetime.now().timestamp() * 1000),
                'origen': 'wawa-calendar'
            })

        # Patrón para eventos con comillas dobles
        p_dq = re.compile(
            r'\{id:"([^"]+)",nombre:"([^"]+)",tipo:"([^"]+)",fecha:"([^"]+)",horarioInicio:"([^"]*)",horarioFin:"([^"]*)"(?:,precioNino:(\d+))?(?:,capacidadMaxima:(\d+))?[^}]*?estado:"([^"]*)"(?:[^}]*?descripcion:"([^"]*)")?(?:[^}]*?edadRecomendada:"([^"]*)")?(?:[^}]*?semana:"([^"]*)")?' 
        )
        for m in p_dq.finditer(content):
            add_ev(m.group(1), m.group(2), m.group(3), m.group(4), m.group(5), m.group(6),
                   m.group(8), m.group(9) or '', m.group(10) or '', m.group(11) or '',
                   m.group(7) or 0, 0)

        # Patrón para shows con comillas simples en nombre
        p_show = re.compile(
            r'\{id:"(may-\d+-show[^"]*)",nombre:\'([^\']+)\',tipo:"show",fecha:"([^"]+)",horarioInicio:"([^"]*)",horarioFin:"([^"]*)"[^}]*?estado:"([^"]*)"(?:[^}]*?descripcion:"([^"]*)")?(?:[^}]*?edadRecomendada:"([^"]*)")?'
        )
        for m in p_show.finditer(content):
            add_ev(m.group(1), m.group(2), 'show', m.group(3), m.group(4), m.group(5),
                   m.group(6), m.group(7) or '', m.group(8) or '', '', 0, 0)

        eventos.sort(key=lambda x: (x['fecha'], x['hora']))
        return eventos, f"{len(eventos)} eventos extraídos"
    except Exception as e:
        return None, str(e)

@app.route("/api/sync-wawa-calendar", methods=["POST", "GET"])
def sync_wawa_calendar():
    """Sincroniza eventos del Wawa Calendar con Casa Wawa OS."""
    eventos, msg = _fetch_wawa_calendar_events()
    if eventos is None:
        return jsonify({"ok": False, "error": msg}), 500

    with _lock:
        # Obtener eventos existentes que NO vienen del wawa-calendar (creados manualmente)
        existing = _store.get("eventos") or []
        manual = [e for e in existing if e.get("origen") != "wawa-calendar"]
        # Combinar: manuales primero + todos los del calendar
        merged = manual + eventos
        _store["eventos"] = merged

    threading.Thread(target=_save_data, daemon=True).start()

    # Emitir por WebSocket a todos los dispositivos
    socketio.emit("data_update", {
        "key": "eventos",
        "value": _store["eventos"],
        "source": "wawa-calendar-sync",
        "ts": int(datetime.now().timestamp() * 1000)
    }, namespace="/sync")

    print(f"[WawaCalendar] ✅ Sincronizados {len(eventos)} eventos ({len(manual)} manuales conservados)")
    return jsonify({
        "ok": True,
        "total": len(_store["eventos"]),
        "calendar": len(eventos),
        "manual": len(manual),
        "msg": msg
    })

# ─── Arranque ─────────────────────────────────────────────────────
_load_seed()
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5555))
    print(f"[CasaWawa] Servidor en puerto {port}...")
    socketio.run(app, host="0.0.0.0", port=port, debug=False,
                 allow_unsafe_werkzeug=True)
