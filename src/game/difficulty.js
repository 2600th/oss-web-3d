// Difficulty: one small table every hostile system reads. Pure data + helpers
// (node-testable). `game.flow.difficulty` / `game.flow.setDifficulty(level)`
// is the API; the setting key is `difficulty` in src/core/Settings.js.
//
//   damage      multiplier on every point of damage the player takes
//   accuracy    hostile aim: gun / AAA / flak error is divided by this
//   aggression  hostile tempo: lock-on and reload times are divided by this
//   missile     multiplier on the G a hostile missile can pull
//   flare       added to a hostile missile's chance of being decoyed by a flare
//   attackers   added to the mission's "fighters shooting at once" cap (min 1)
//   score       multiplier on the final score (ranks are the same on every level)

export const DIFFICULTY_LEVELS = ['easy', 'normal', 'hard'];

export const DIFFICULTY = {
  easy: {
    id: 'easy', label: 'Easy', description: 'Hostile fire hurts less, aims worse and comes less often. Flares work more reliably.',
    damage: 0.6, accuracy: 0.7, aggression: 0.7, missile: 0.85, flare: 0.15, attackers: -1, score: 0.85,
  },
  normal: {
    id: 'normal', label: 'Normal', description: 'The intended fight.',
    damage: 1, accuracy: 1, aggression: 1, missile: 1, flare: 0, attackers: 0, score: 1,
  },
  hard: {
    id: 'hard', label: 'Hard', description: 'Hostile fire hurts more, aims better and comes faster. Missiles turn harder and flares fail more often.',
    damage: 1.35, accuracy: 1.3, aggression: 1.3, missile: 1.15, flare: -0.12, attackers: 1, score: 1.2,
  },
};

export const DEFAULT_DIFFICULTY = 'normal';

export function difficultyFor(level) {
  return DIFFICULTY[level] ?? DIFFICULTY[DEFAULT_DIFFICULTY];
}

/** Menu rows: `[{id, label, description}]`. */
export function difficultyList() {
  return DIFFICULTY_LEVELS.map((id) => ({ id, label: DIFFICULTY[id].label, description: DIFFICULTY[id].description }));
}

/** A pilot skill table (ai/brain.js SKILLS entry) at a difficulty. Pure. */
export function scaleSkill(skill, d) {
  return {
    ...skill,
    lockTime: skill.lockTime / d.aggression,
    mslCooldown: skill.mslCooldown / d.aggression,
    reaction: skill.reaction / Math.sqrt(d.aggression),
    gunError: skill.gunError / d.accuracy,
  };
}
