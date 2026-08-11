// ============================================================
// Form cues for the main compound lifts
// ============================================================
//
// Written for this app, not imported. That matters twice over:
//
//   1. The wger descriptions in the exercises table are CC-BY-SA. Keeping
//      these in code rather than in the same column keeps licensed text and
//      original text from being mixed into one indistinguishable blob.
//   2. wger's coverage is uneven — some descriptions are one line, some are
//      absent. These cover the lifts that carry load, where a form error is
//      worth more than a missing sentence.
//
// Deliberately not exhaustive. There are 722 exercises in the library and
// roughly thirty of them are worth this much detail; padding the rest with
// generic filler would make the good ones harder to trust.
//
// Matching is by pattern over the exercise name, most specific first, because
// the library's names come from a community database and are not consistent
// ("Bench Press", "Barbell Bench Press", "Incline Bench Press - MP").
// ============================================================

/**
 * @typedef {Object} Cues
 * @property {string[]} setup     - before the first rep
 * @property {string[]} execution - during the set
 * @property {string[]} faults    - what usually goes wrong
 */

/** [pattern, cues] — first match wins, so put narrower patterns first. */
const CUES = [
  // ---- Hinge ----
  [/\b(romanian deadlift|rdl)\b/i, {
    setup: [
      'Bar against the thighs, feet hip width, knees softly bent and then held there.',
      'Shoulders down and back so the lats hold the bar close.',
    ],
    execution: [
      'Push the hips backwards rather than bending down — the bar travels because the hips move.',
      'Stop when the hamstrings stop lengthening, usually around mid-shin. Depth is not the goal.',
      'Stand up by driving the hips forward, finishing tall rather than leaning back.',
    ],
    faults: [
      'Turning it into a squat by bending the knees further as you descend.',
      'Letting the bar drift forward of the mid-foot, which loads the lower back.',
      'Chasing depth by rounding the spine once the hamstrings have run out.',
    ],
  }],
  [/\bdeadlift\b/i, {
    setup: [
      'Bar over the mid-foot, roughly an inch from the shins.',
      'Grip just outside the knees, then pull the slack out of the bar until it clicks.',
      'Chest up, spine neutral — take a breath and brace before the bar moves.',
    ],
    execution: [
      'Push the floor away rather than pulling with the arms.',
      'Hips and shoulders rise together; the bar stays in contact with the legs.',
      'Lock out by squeezing the glutes, not by leaning back past vertical.',
    ],
    faults: [
      'Hips shooting up first, which turns it into a stiff-legged pull.',
      'The bar drifting away from the shins and rounding the upper back.',
      'Yanking the bar off the floor before the slack is out.',
    ],
  }],
  [/\bhip thrust\b/i, {
    setup: [
      'Shoulder blades on the bench, feet flat and far enough forward that the shins are vertical at the top.',
      'Tuck the ribs down so the movement comes from the hips, not the lower back.',
    ],
    execution: [
      'Drive through the heels and finish with the hips level with the knees.',
      'Hold the top for a beat with the glutes squeezed.',
    ],
    faults: [
      'Arching the lower back to fake extra height at the top.',
      'Feet too close, which makes it a quad exercise.',
    ],
  }],
  [/\bgood.?morning\b/i, {
    setup: [
      'Bar high on the traps, feet hip width, knees soft.',
      'Start much lighter than feels necessary — the leverage is unforgiving.',
    ],
    execution: [
      'Hinge at the hips with a neutral spine, chest leading.',
      'Stop when the back would otherwise round, and drive the hips forward to stand.',
    ],
    faults: ['Going too heavy too soon.', 'Rounding through the mid-back at the bottom.'],
  }],

  // ---- Squat ----
  [/\bfront squat\b/i, {
    setup: [
      'Bar resting on the front delts, not held by the hands — fingers are there to stop it rolling.',
      'Elbows high and driven forward; this is what keeps the torso upright.',
    ],
    execution: [
      'Sit straight down with the torso as vertical as you can hold.',
      'Keep the elbows up throughout — the bar falls the moment they drop.',
    ],
    faults: [
      'Elbows dropping, which tips the bar forward and dumps it.',
      'Gripping the bar in the palms instead of letting it sit on the shoulders.',
    ],
  }],
  [/\b(bulgarian|split squat)\b/i, {
    setup: [
      'Rear foot on the bench, front foot far enough forward that the front shin stays near vertical.',
      'Most of the weight through the front leg; the back leg is for balance.',
    ],
    execution: [
      'Lower straight down until the back knee is near the floor.',
      'Drive through the front heel to stand.',
    ],
    faults: [
      'Front foot too close, which grinds the knee forward.',
      'Pushing off the back foot and turning it into a shallow lunge.',
    ],
  }],
  [/\bsquat\b/i, {
    setup: [
      'Bar even on the traps, hands as narrow as the shoulders allow without pain.',
      'Feet shoulder width, toes turned out slightly, weight through the whole foot.',
      'Breathe in and brace the whole trunk before unracking.',
    ],
    execution: [
      'Break at the hips and knees together, knees tracking over the toes.',
      'Descend to at least parallel if your hips and ankles allow it without the pelvis tucking.',
      'Drive up with the chest and hips rising at the same rate.',
    ],
    faults: [
      'Hips rising faster than the chest, turning it into a good morning.',
      'Knees collapsing inwards under load.',
      'Losing the brace at the bottom.',
    ],
  }],
  [/\bleg press\b/i, {
    setup: ['Feet mid-platform, roughly shoulder width.', 'Back and hips flat against the pad.'],
    execution: ['Lower under control until the knees reach about 90 degrees.', 'Press without snapping the knees straight.'],
    faults: [
      'Going so deep the pelvis lifts off the pad and rounds the lower back.',
      'Locking the knees hard at the top.',
    ],
  }],

  // ---- Horizontal push ----
  [/\b(incline bench|incline dumbbell press|incline press)\b/i, {
    setup: [
      'Bench at roughly 30 degrees — steeper turns it into a shoulder press.',
      'Shoulder blades pulled back and down into the bench.',
    ],
    execution: [
      'Lower to the upper chest, just below the collarbone.',
      'Press slightly back towards the eyeline rather than straight up.',
    ],
    faults: ['Setting the bench too steep.', 'Letting the elbows flare to ninety degrees.'],
  }],
  [/\b(bench press|chest press)\b/i, {
    setup: [
      'Shoulder blades retracted and pinned to the bench, feet flat on the floor.',
      'Grip so the forearms are vertical at the bottom, not wider.',
      'Small natural arch in the lower back; hips stay in contact with the bench.',
    ],
    execution: [
      'Lower to the lower chest with the elbows at roughly 45 degrees to the torso.',
      'Touch, then press — no bouncing off the ribs.',
      'Keep the shoulder blades pinned the whole way up.',
    ],
    faults: [
      'Elbows flared straight out to the sides, which is where shoulders get hurt.',
      'Losing the shoulder blade position and pressing off a rounded upper back.',
      'Lifting the hips off the bench to move heavier weight.',
    ],
  }],
  [/\b(press.?up|push.?up)\b/i, {
    setup: ['Hands under the shoulders, body in one line from head to heels.', 'Ribs down, glutes squeezed.'],
    execution: ['Lower until the chest is just off the floor, elbows at about 45 degrees.', 'Press up without letting the hips sag or pike.'],
    faults: ['Hips sagging as the set gets hard.', 'Head dropping forward before the chest.'],
  }],
  [/\bdip\b/i, {
    setup: ['Shoulders down away from the ears before the first rep.', 'Lean the torso slightly forward for chest, stay upright for triceps.'],
    execution: ['Lower until the upper arms are roughly parallel to the floor.', 'Press back up without shrugging at the top.'],
    faults: ['Dropping deeper than the shoulders comfortably allow.', 'Shrugging up into the shoulders at the bottom.'],
  }],

  // ---- Vertical push ----
  [/\b(overhead press|shoulder press|military press)\b/i, {
    setup: [
      'Bar on the front delts, hands just outside the shoulders.',
      'Squeeze the glutes and brace so the lower back does not take the load.',
    ],
    execution: [
      'Move the head back out of the way, press up, then push the head through as the bar passes.',
      'Finish with the bar over the mid-foot, biceps beside the ears.',
    ],
    faults: [
      'Leaning back to turn it into an incline press.',
      'Pressing around the face instead of moving the head.',
    ],
  }],

  // ---- Vertical pull ----
  [/\b(pull.?up|chin.?up)\b/i, {
    setup: ['Full hang with the shoulders active, not slack.', 'Ribs down so you are not hanging from the lower back.'],
    execution: ['Pull the elbows down towards the ribs, chest to the bar.', 'Lower under control to a full hang each rep.'],
    faults: ['Kipping when the reps get hard.', 'Stopping short of a full hang and shortening the range each rep.'],
  }],
  [/\b(lat pulldown|pulldown|pull.?down)\b/i, {
    setup: ['Thighs secured, torso upright or leaned back very slightly.', 'Grip just outside the shoulders.'],
    execution: ['Pull the bar to the upper chest by driving the elbows down.', 'Control the bar back up until the lats are fully lengthened.'],
    faults: ['Leaning far back and rowing instead of pulling down.', 'Pulling the bar behind the neck.'],
  }],

  // ---- Horizontal pull ----
  [/\b(barbell row|bent.?over row|pendlay)\b/i, {
    setup: ['Hinge to roughly 45 degrees or lower, spine neutral, braced.', 'Bar hanging under the shoulders.'],
    execution: ['Pull to the lower ribs, elbows driving back rather than out.', 'Lower under control without letting the torso rise.'],
    faults: [
      'The torso rising to meet the bar as the set gets hard.',
      'Jerking with the lower back rather than rowing with the back muscles.',
    ],
  }],
  [/\brow\b/i, {
    setup: ['Chest up, shoulders down, spine neutral.', 'Start from a full stretch with the shoulder blade protracted.'],
    execution: ['Row by driving the elbow back, finishing with the shoulder blade squeezed.', 'Return to a full stretch each rep.'],
    faults: ['Shrugging instead of retracting.', 'Cutting the range short at the stretched end.'],
  }],
  [/\bface pull\b/i, {
    setup: ['Cable at roughly face height, rope attachment.', 'Light weight — this is a postural exercise, not a strength lift.'],
    execution: ['Pull towards the face, hands finishing beside the ears.', 'Externally rotate at the end so the knuckles face back.'],
    faults: ['Going too heavy and turning it into a high row.', 'Shrugging the traps up.'],
  }],

  // ---- Carry ----
  [/\b(farmer|carry|suitcase)\b/i, {
    setup: ['Stand tall, ribs down, shoulders back before you take a step.'],
    execution: ['Walk with short, controlled steps.', 'Resist leaning towards the loaded side on single-sided carries.'],
    faults: ['Letting the shoulders round forward under the load.', 'Rushing and losing the upright position.'],
  }],
];

/**
 * Cues for one exercise, or null when there are none.
 *
 * Returning null rather than a generic placeholder is deliberate: the value of
 * these is that they are specific, and "keep good form" attached to 700
 * exercises would teach the reader to ignore the section entirely.
 *
 * @param {string} name
 * @returns {Cues|null}
 */
export function cuesFor(name) {
  const label = String(name || '');
  if (!label.trim()) return null;

  for (const [pattern, cues] of CUES) {
    if (pattern.test(label)) return cues;
  }
  return null;
}

/** How many lifts carry cues — used by tests and the library heading. */
export function cueCount() {
  return CUES.length;
}
