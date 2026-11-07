'use strict';
// The habits.md that Today seeded before the portable starter set. Tests and the sandbox that
// rely on these rows (wake, gym, ...) use it instead of the neutral DEFAULT_HABITS_MD.

const LEGACY_HABITS_MD = `# Habits

Edit the table to change your habits. Keep the id when you rename a habit, or its history won't line up.

| id | Habit | Icon | Focus goal (min) |
| --- | --- | --- | --- |
| wake | Wake up at 5:00 | sun | |
| gym | Gym / run / stretch | dumbbell | |
| outside | Go outside | tree | |
| business | Business 1h | rocket | 60 |
| vitamins | Take vitamins | pill | |
| read | Read 30m | book | 30 |
| learn | Self-learning 1h | cap | 60 |
| nocoffee | No coffee | coffee-off | |
`;

module.exports = { LEGACY_HABITS_MD };
