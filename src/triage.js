/* Rule-based severity triage ("AI suggestion").
   score = base score for the incident type + points for risk keywords found in the notes.
   Reducer phrases ("no recent activity") lower the score and are removed from the text
   first so they are not double-counted by the keyword rules. */

const BASE = {
  'Poaching activity': 8,
  'Snare found': 5,
  'Carcass found': 4,
  'Injured animal': 3,
  'Fence breach': 2,
  'Vehicle in restricted area': 1,
  'Other': 1,
  'Wildlife sighting': 0,
};

const REDUCERS = ['no recent activity', 'no activity', 'no sign', 'inactive', 'routine', 'old'];

// Most specific phrases first — each match is removed from the text so shorter keywords can't re-count it.
const RULES = [
  ['horns removed', 4], ['horn removed', 4], ['tusks removed', 4],
  ['gunshot', 3], ['gunfire', 3], ['gun shot', 3], ['armed', 3], ['rifle', 3], ['firearm', 3],
  ['poacher', 3], ['suspect', 3], ['intruder', 3],
  ['vehicle tracks', 2],
  ['fresh', 1], ['recent', 1],
  ['blood', 2], ['horn', 2], ['tusk', 2], ['wound', 2], ['injur', 2], ['trap', 2], ['snare', 2],
  ['cut', 2], ['fire', 2], ['smoke', 2],
  ['tracks', 1], ['breach', 1], ['sick', 1], ['dehydrat', 1], ['vehicle', 1],
];

const HIGH_AT = 8;
const MEDIUM_AT = 3;

function triage(type = '', notes = '') {
  let text = ' ' + String(notes || '').toLowerCase() + ' ';
  let score = BASE[type] !== undefined ? BASE[type] : 1;
  const reasons = [];

  // Keywords match at the start of a word (so "cut" matches "cutting" but not "shortcut").
  const has = (needle) => new RegExp('\\b' + needle).test(text);
  const strip = (needle) => { text = text.replace(new RegExp('\\b' + needle, 'g'), ' '); };

  REDUCERS.forEach((phrase) => {
    if (has(phrase)) { score -= 2; reasons.push('-2 ' + phrase); strip(phrase); }
  });
  RULES.forEach(([needle, points]) => {
    if (has(needle)) { score += points; reasons.push('+' + points + ' ' + needle); strip(needle); }
  });

  const severity = score >= HIGH_AT ? 'High' : score >= MEDIUM_AT ? 'Medium' : 'Low';
  return { severity, score, reasons };
}

module.exports = { triage };
