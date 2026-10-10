extends Node

class_name ResponseUIManager

@export var response_choice_template: PackedScene

@onready var hbox_container: = $HBoxContainer

signal on_response_selected

func _ready() -> void :
	self.visible = false

func display_choices(choices: Array[String]):
	for child in hbox_container.get_children():
		child.queue_free()
	self.visible = true

	for choice in choices:
		var template_spawn = response_choice_template.instantiate()
		hbox_container.add_child(template_spawn)
		template_spawn.get_node("MarginContainer/RichTextLabel").text = choice
		template_spawn.get_node("Button").pressed.connect(invoke_response_selected)

func invoke_response_selected():
	self.visible = false
	on_response_selected.emit()
