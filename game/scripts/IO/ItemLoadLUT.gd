extends Node

@export var item_lookup: Dictionary[String, ItemData] = {}

func register_item(item: ItemData) -> void :
	item_lookup[item.item_id] = item

func get_item(item_id: String) -> ItemData:
	return item_lookup.get(item_id)

func _ready() -> void :
	load_folder("res://story/itemdata")

func load_folder(path: String) -> void :
	var dir: = DirAccess.open(path)

	if dir == null:
		push_error("Couldn't open " + path)
		return

	dir.list_dir_begin()

	var file_name: = dir.get_next()

	while file_name != "":
		var full_path: = path + "/" + file_name

		if dir.current_is_dir():
			if file_name != "." and file_name != "..":
				load_folder(full_path)

		elif file_name.ends_with(".tres") or file_name.ends_with(".tres.remap"):
			var clean_path = full_path.trim_suffix(".remap")
			var item: ItemData = load(clean_path)

			if item != null:
				register_item(item)

		file_name = dir.get_next()

	dir.list_dir_end()
