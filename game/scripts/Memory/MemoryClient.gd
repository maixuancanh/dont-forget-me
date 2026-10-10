extends Node
## One serialized request at a time. Cancellation invalidates queued callbacks.
signal activity(text: String)
signal session_refreshed(data: Dictionary)
var base_url := "http://127.0.0.1:8798"
var token := ""
var refresh_token := ""
var user_id := ""
var refresh_http: HTTPRequest
var refresh_callback: JavaScriptObject
var refreshing := false
var generation := 0
var queue: Array[Dictionary] = []
var active: Dictionary = {}
var http: HTTPRequest

func _ready() -> void:
	# Web clients use the Vercel origin and its Railway API rewrites.
	if OS.has_feature("web"):
		base_url = str(JavaScriptBridge.eval("window.location.origin")).trim_suffix("/")
	var configured := OS.get_environment("DFM_SERVICE_URL").strip_edges()
	if not configured.is_empty():
		base_url = configured.trim_suffix("/")
	http = HTTPRequest.new()
	# Fetch decompresses HTTP responses in browsers. Godot must not decode twice.
	if OS.has_feature("web"):
		http.accept_gzip = false
	http.timeout = 45.0
	add_child(http)
	http.request_completed.connect(_completed)

func send(path: String, method: int, payload: Dictionary, callback: Callable) -> void:
	queue.append({"path": path, "method": method, "payload": payload, "callback": callback, "generation": generation})
	_next()

func cancel_all() -> void:
	generation += 1
	queue.clear()
	active.clear()
	refreshing = false
	if is_instance_valid(http): http.cancel_request()
	if is_instance_valid(refresh_http):
		refresh_http.cancel_request()
		refresh_http.queue_free()

func _exit_tree() -> void:
	cancel_all()

func _next() -> void:
	if not active.is_empty() or queue.is_empty():
		return
	active = queue.pop_front()
	_dispatch_active()

func _dispatch_active() -> void:
	if not _valid_service_url():
		_finish(false, {"error": "Memory service requires HTTPS except for localhost development."})
		return
	var headers := PackedStringArray(["Content-Type: application/json"])
	if not token.is_empty():
		headers.append("Authorization: Bearer " + token)
	activity.emit("Contacting memory service…")
	var body := "" if active.method == HTTPClient.METHOD_GET else JSON.stringify(active.payload)
	var error := _dispatch(headers, body)
	if error != OK:
		_finish(false, {"error": "Service unavailable. Retry when the backend is running."})

func _dispatch(headers: PackedStringArray, body: String) -> int:
	return http.request(base_url + active.path, headers, active.method, body)

func _completed(result: int, code: int, _headers: PackedStringArray, body: PackedByteArray) -> void:
	if active.is_empty(): return
	if result == HTTPRequest.RESULT_SUCCESS and code == 401 and not token.is_empty() and not str(active.path).begins_with("/v1/auth/") and not active.get("refreshed", false):
		active.refreshed = true
		refreshing = true
		activity.emit("Renewing your secure session…")
		_start_refresh()
		return
	var data: Variant = {} if body.is_empty() else JSON.parse_string(body.get_string_from_utf8())
	if not data is Dictionary:
		data = {"error": "Invalid memory service response."}
	var success := result == HTTPRequest.RESULT_SUCCESS and code >= 200 and code < 300
	if not success and code == 401:
		data.error = "Your secure session has expired. Open Account, select Resume browser session, then retry. Your case is saved."
	if not success and str(data.get("code", "")) == "PROVIDER_RATE_LIMITED":
		data.error = "The AI provider is rate limited. Your conversation is held; retry shortly."
	if not success and not data.has("error"):
		data.error = "Request failed (%s). Retry." % code
	_finish(success, data)

func _start_refresh() -> void:
	var requested_generation := generation
	if OS.has_feature("web"):
		refresh_callback = JavaScriptBridge.create_callback(func(args: Array):
			var data: Variant = JSON.parse_string(str(args[0]))
			_refresh_result(data if data is Dictionary else {}, requested_generation))
		JavaScriptBridge.get_interface("window").dfmRefreshCallback = refresh_callback
		JavaScriptBridge.eval("((callback)=>{(async()=>{try{let r=await fetch('/v1/auth/csrf',{credentials:'same-origin',signal:AbortSignal.timeout(15000)});let c=await r.json();r=await fetch('/v1/auth/access',{method:'POST',credentials:'same-origin',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json','X-CSRF-Token':c.csrfToken},body:'{}'});const s=await r.json();callback(JSON.stringify(r.ok?s:{}));}catch{callback('{}');}})();})(window.dfmRefreshCallback)")
		return
	if refresh_token.is_empty():
		_refresh_result({}, requested_generation)
		return
	refresh_http = HTTPRequest.new()
	refresh_http.timeout = 15.0
	add_child(refresh_http)
	refresh_http.request_completed.connect(func(result: int, code: int, _headers: PackedStringArray, body: PackedByteArray):
		var data: Variant = JSON.parse_string(body.get_string_from_utf8())
		_refresh_result(data if result == HTTPRequest.RESULT_SUCCESS and code == 200 and data is Dictionary else {}, requested_generation))
	var error := refresh_http.request(base_url + "/v1/auth/refresh", PackedStringArray(["Content-Type: application/json", "Authorization: Bearer " + token]), HTTPClient.METHOD_POST, JSON.stringify({"refreshToken": refresh_token}))
	if error != OK: _refresh_result({}, requested_generation)

func _refresh_result(data: Dictionary, requested_generation: int) -> void:
	if requested_generation != generation or active.is_empty() or not refreshing: return
	refreshing = false
	if is_instance_valid(refresh_http): refresh_http.queue_free()
	var next_token := str(data.get("accessToken", ""))
	if next_token.is_empty() or user_id.is_empty() or str(data.get("userId", "")) != user_id:
		_finish(false, {"error": "Your secure session has expired or changed. Open Account and resume browser sign-in. Your case is saved."})
		return
	token = next_token
	refresh_token = str(data.get("refreshToken", refresh_token))
	session_refreshed.emit(data)
	_dispatch_active()

func _finish(success: bool, data: Dictionary) -> void:
	var request := active
	active = {}
	if not request.is_empty() and request.generation == generation and request.callback.is_valid():
		request.callback.call(success, data)
	_next()

func _valid_service_url() -> bool:
	if base_url.begins_with("https://"):
		return not base_url.trim_prefix("https://").is_empty()
	if not base_url.begins_with("http://"):
		return false
	var authority := base_url.trim_prefix("http://").split("/", false)[0]
	var loopback := RegEx.new()
	loopback.compile("^(localhost|127\\.0\\.0\\.1|\\[::1\\])(:[0-9]{1,5})?$")
	return loopback.search(authority) != null
