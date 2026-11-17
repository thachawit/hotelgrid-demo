// Reference classifier the simulator treats as ground truth before applying a model's simulated error rate.
const COMPLAINT = /(not working|ignored|disappointed|noise|broken|still hot|ไม่เย็น|เสีย|เสียงดัง|ไม่พอใจ|นานมาก|ไม่ทำงาน)/i;
const TEMP_WORD = /(degree|°|\bac\b|aircon|temperature|\bset\b|แอร์|องศา|อุณหภูมิ)/i;
const STATUS = /(what'?s the temperature|what is the room temperature|is my ac on|how warm|กี่องศา|เปิดอยู่ไหม|เท่าไหร่|เช็คอุณหภูมิ)/i;
const SERVICE = /(towel|housekeeping|pillow|water|blanket|ผ้าเช็ดตัว|แม่บ้าน|หมอน|น้ำดื่ม)/i;
const ITEMS = [[/towel|ผ้าเช็ดตัว/i, 'towels'], [/housekeeping|แม่บ้าน/i, 'housekeeping'], [/pillow|หมอน/i, 'pillows'], [/water|น้ำดื่ม/i, 'water']];

export const INTENTS = ['set_temperature', 'room_status', 'request_service', 'complaint', 'other'];

export function classify(raw) {
  // strip a "Current time: ...\nGuest: ..." wrapper if the caller moved the timestamp into the user turn
  const text = String(raw).includes('Guest:') ? String(raw).split('Guest:').pop().trim() : String(raw);
  const num = text.match(/(\d{2}(?:\.\d)?)/);
  if (COMPLAINT.test(text)) return { intent: 'complaint', temperature: null, item: null };
  if (num && TEMP_WORD.test(text)) return { intent: 'set_temperature', temperature: Number(num[1]), item: null };
  if (STATUS.test(text)) return { intent: 'room_status', temperature: null, item: null };
  if (SERVICE.test(text)) return { intent: 'request_service', temperature: null, item: (ITEMS.find(([re]) => re.test(text)) || [, 'service'])[1] };
  return { intent: 'other', temperature: null, item: null };
}
