extends RefCounted
var npc_id := ""
var revision := 0
func set_npc(value: String) -> void:
	if value != npc_id:
		npc_id = value
		revision += 1
func turn_id() -> String:
	return "%s-%s-%s" % [Time.get_unix_time_from_system(), Time.get_ticks_usec(), randi()]
