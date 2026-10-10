extends InteractionPlaceItems
class_name InteractionPay

@export var purchase_to_pay: InteractionRequireItems

@export_range(0.0, 1.0)
var wealth_factor: = 0.5

func _compute_total_cost() -> int:
	var total: = 0

	for item_data in purchase_to_pay.required_items:
		var qty = purchase_to_pay.required_items[item_data]

		total += item_data.item_cost * qty

	return total
