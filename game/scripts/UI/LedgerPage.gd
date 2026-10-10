extends Control

# Plot-bearing records remain readable when the art scales or letterboxes.
func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	resized.connect(queue_redraw)
	MemoryGame.witness("Ledger", 0)

func ink(font: Font, at: Vector2, value: String, height: int = 29) -> void:
	draw_string_outline(font, at, value, HORIZONTAL_ALIGNMENT_LEFT, -1, height, 4, Color(0.18,0.13,0.1))
	draw_string(font, at, value, HORIZONTAL_ALIGNMENT_LEFT, -1, height, Color.WHITE)

func _draw() -> void:
	var fit = minf(size.x / 1450.0, size.y / 978.0)
	draw_set_transform((size - Vector2(1450,978)*fit)*0.5, 0, Vector2.ONE*fit)
	var font = load("res://assets/ui/fonts/Charcoal-Regular.ttf") as Font
	ink(font, Vector2(315,260), "NEIGHBORHOOD ACCOUNTS", 34)
	ink(font, Vector2(315,320), "July 2026 - VND", 29)
	ink(font, Vector2(315,395), "Binh - Friday: PAID", 29)
	ink(font, Vector2(315,450), "1,000,000 VND / Hanh", 29)
	ink(font, Vector2(315,520), "Saturday: entered again", 29)
	ink(font, Vector2(315,580), "No new cash issued.", 29)
	var rows = [["Lan", "150,000", "Paid"], ["Thu", "120,000", "Paid"],
		["Sau", "500,000", "Open"], ["Tuan", "80,000", "Paid"],
		["Binh", "1,000,000", "Friday: paid"], ["Binh", "1,000,000", "Saturday"],
		["", "", ""], ["", "", ""], ["Binh", "", "Closed"]]
	for i in range(rows.size()):
		var y = 320 + i*51
		ink(font, Vector2(835,y), rows[i][0])
		ink(font, Vector2(1010,y), rows[i][1])
		ink(font, Vector2(1185,y), rows[i][2])
	draw_line(Vector2(828,718), Vector2(935,728), Color(0.55,0.05,0.035), 5)
	draw_line(Vector2(828,733), Vector2(933,713), Color(0.55,0.05,0.035), 4)
