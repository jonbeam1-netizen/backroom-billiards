// The shapes the rules give to the rest of the game. Types only, no code.
// Everything here is plain data: numbers, strings, arrays and plain objects, so a state can be
// copied with JSON, sent to the other player, and hashed.
//
// Directions: metres and seconds, Y up. The table runs along Z, break end at +Z, rack end at -Z.
// X 0, Z 0 is the centre of the playing surface; Y 0 is the top of the felt.
// A ball resting on the felt has y equal to the ball radius.

/**
 * @typedef {Object} GameData
 * @property {Object} table    data/table.json
 * @property {Object} physics  data/physics.json
 */

/**
 * @typedef {Object} Ball
 * @property {number} id        0 is the cue ball, 1 to 15 are the numbered balls
 * @property {'cue'|'solid'|'stripe'|'eight'} kind   1-7 solid, 8 eight, 9-15 stripe
 * @property {'table'|'potted'|'off'} where   on (or above) the table / dropped in a pocket / left the table
 * @property {number} pocket    index into TableGeometry.pockets when potted, else -1
 * @property {number} x  @property {number} y  @property {number} z      centre of the ball
 * @property {number} vx @property {number} vy @property {number} vz     velocity, m/s
 * @property {number} wx @property {number} wy @property {number} wz     spin, radians per second
 * @property {number} qx @property {number} qy @property {number} qz @property {number} qw   which way the ball is turned (unit quaternion), for drawing
 * @property {boolean} moving   false once it has come to rest
 */

/**
 * @typedef {Object} GameState
 * @property {number} tick      ticks since the game was made (60 a second)
 * @property {'practice'} mode
 * @property {string} size      key into table.sizes: '7', '8' or '9'
 * @property {number} seed      the seeded generator's current value (build rule 5)
 * @property {'aim'|'rolling'|'place'} phase   waiting for a shot / balls are moving / the cue ball is in hand
 * @property {Ball[]} balls     always 16, index equals id
 * @property {number} shots     shots taken so far
 * @property {NudgeState} [nudge]  only while the nudge is switched on (item 41); missing means off
 */

/**
 * The nudge (HANDOFF item 41, rules/nudge.js). Present on the state only while the nudge is on, in practice
 * and in a match alike; it is copied by cloneState and hashed only when present, so a state without it hashes
 * exactly as before item 41.
 * @typedef {Object} NudgeState
 * @property {number[]} next   per player (0, 1; practice uses 0): the first tick at which that player may nudge again
 */

/**
 * What a player does. Passed to step() on the tick it happens.
 * @typedef {ShootAction|PlaceAction|NudgeAction|NudgeSettingAction} Action
 *
 * @typedef {Object} NudgeAction   shove the table (item 41, W A S D during a roll). Ignored unless state.nudge exists,
 *           the phase is 'rolling' (a shot is in play), the tick has reached state.nudge.next[by] and (dirX, dirZ) is
 *           exactly one of (1,0), (-1,0), (0,1), (0,-1). Never a foul by itself.
 * @property {'nudge'} type
 * @property {0|1} by        who nudged: 0 host / player 1 / practice, 1 friend / player 2
 * @property {number} dirX   the way the balls are kicked relative to the table (the key's way on the screen,
 * @property {number} dirZ   turned into a table direction by the view)
 *
 * @typedef {Object} NudgeSettingAction   practice only: the table's nudge button (ignored in a match)
 * @property {'nudgeSetting'} type
 * @property {boolean} on
 *
 * @typedef {Object} ShootAction
 * @property {'shoot'} type
 * @property {number} dirX   unit direction along the felt the cue points, X part
 * @property {number} dirZ   and Z part (dirX*dirX + dirZ*dirZ = 1)
 * @property {number} speed  how fast the cue ball leaves, m/s (0 to physics.maxShotSpeed)
 * @property {number} offX   where the tip hits, sideways, -1 (left edge) to 1 (right edge), 0 = centre
 * @property {number} offY   where the tip hits, up/down, -1 (bottom) to 1 (top), 0 = centre
 * @property {number} elevSin  sine of how far the butt of the cue is raised (0 = level)
 * @property {number} elevCos  cosine of the same angle
 *
 * @typedef {Object} PlaceAction
 * @property {'place'} type   put the cue ball down while phase is 'place'
 * @property {number} x
 * @property {number} z
 */

/**
 * What happened during a tick. `speed` is how hard the hit was (m/s along the line of the hit),
 * so the sound can follow it.
 * @typedef {Object} GameEvent
 * @property {'cueStrike'|'ballBall'|'cushion'|'tableBounce'|'railBounce'|'pocket'|'offTable'|'settled'|'nudge'} type
 *           'nudge' (item 41): { player, dirX, dirZ, speed }; every ball on the table got `speed` (m/s) the way
 *           dirX, dirZ (one of +X, -X, +Z, -Z); the table itself was shoved the other way. Comes before the tick's ball events.
 * @property {number} [player]  who nudged (nudge)
 * @property {number} [dirX] @property {number} [dirZ]   the way the balls were kicked (nudge)
 * @property {number} [ball]    the ball it happened to
 * @property {number} [other]   the second ball (ballBall)
 * @property {number} [pocket]  index into TableGeometry.pockets (pocket)
 * @property {number} [speed]
 * @property {number} [x] @property {number} [y] @property {number} [z]   where it happened
 */

/**
 * The table worked out from data/table.json for one size. Used by the rules for hits and by the view for drawing.
 * @typedef {Object} TableGeometry
 * @property {number} length  @property {number} width      playing surface between the cushion noses
 * @property {number} halfL   @property {number} halfW
 * @property {{ax:number, az:number, bx:number, bz:number, nx:number, nz:number, kind:'nose'|'jaw'}[]} cushions
 *           straight pieces of cushion edge; (nx, nz) points into the playing area
 * @property {{x:number, z:number, r:number, kind:'corner'|'side'}[]} pockets   6 holes
 * @property {number} lineZ   Z of the line; behind the line is z > lineZ
 * @property {number} rackX   @property {number} rackZ      where the front ball of the rack sits
 * @property {number} outerHalfL  @property {number} outerHalfW   the outer edge of the wooden rail
 */

/**
 * The answer of firstContact(): what a level, centre-hit cue ball meets first, by plain geometry.
 * @typedef {Object} Contact
 * @property {'ball'|'cushion'|'pocket'|'none'} kind
 * @property {number} x  @property {number} z   where the cue ball's centre is at that moment
 * @property {number} ballId                    the ball that is hit, or -1
 * @property {number} targetDirX @property {number} targetDirZ   which way the hit ball sets off (0, 0 when no ball)
 * @property {number} cueDirX    @property {number} cueDirZ      which way the cue ball leaves (the bounce off a cushion, the glance off a ball)
 */

// ------------------------------------------------------------------------------------------------
// The 8-ball match (mode 'match'). Practice (mode 'practice') ignores all of this.
//
// Jon's rules (HANDOFF.md, Decisions, 2026-11-22 and 2026-11-23):
// - Coin flip for the first break (from the seed); on a rematch the winner breaks.
// - The breaker puts the cue ball down anywhere behind the line, then breaks.
// - The 8 dropping on the break, or leaving the table on the break: rack again, the same player breaks
//   again. Not a win or a loss, and not a foul. (Changed 2026-11-23, HANDOFF item 29: the 8 leaving the
//   table on the break used to lose.)
// - The table stays open after the break. Your group is the first ball you sink, without a foul,
//   on a shot after the break.
// - Fouls: the cue ball drops in a pocket or leaves the table; the cue ball touches no ball (only when
//   the host's noHitFoul setting is on, see below); the first ball the cue ball touches is not one of
//   yours (open table: any ball but the 8 is fine; on the break the 8 is fine too; once you are on the 8,
//   the 8 must be first); after the cue ball's first touch no ball reaches a cushion and no ball drops;
//   any ball leaves the table.
// - The cue ball touching no ball (HANDOFF item 31, host setting noHitFoul, default false):
//   off: not a foul. The turn passes to the other player, the cue ball stays where it stopped, no cue
//   ball in hand; the "a ball must reach a cushion" foul does not apply (there was no hit). If the cue
//   ball drops or leaves the table on that shot, it is still a foul (scratch / cueOffTable).
//   On: a foul, the other player has the cue ball in hand.
// - Hitting the 8 first on the break is not a foul (HANDOFF item 30). Later, on an open table, it is.
// - After a foul the other player has the cue ball in hand: anywhere on the table, or only behind the
//   line, as the foulRule setting says.
// - You keep shooting while you sink a ball of your own without a foul (on an open table: any ball but
//   the 8; on the break: any ball). Otherwise the turn passes.
// - A numbered ball that leaves the table stays out and counts as sunk for its group (and it is a foul).
// - The 8: you may only shoot at it once your group is gone. No pocket is called (changed 2026-11-23,
//   HANDOFF item 38: you used to click a pocket first, and the 8 in another pocket lost).
//   You win by sinking it in any pocket without a foul. You lose by: sinking it before your
//   group is gone; sinking it on a shot that is a foul (for example the cue ball drops too); the 8
//   leaving the table (except on the break). If you foul on the 8 shot and the 8 stays up, it is only a foul.
// - The nudge (HANDOFF item 41, W A S D, host setting, off by default; createGame opts.nudge): either player may nudge
//   while a shot is in play (from the strike until the balls rest), each with their own wait. A nudge is never a
//   foul. Everything it causes belongs to the shot in play and is judged with it by the rules above, for the
//   shooter, whoever nudged: a ball it drops counts as sunk by the shot, the 8 follows the 8 rules, the cue ball
//   dropping is the shooter's scratch. Contacts it causes count like any other contact of the shot: if it pushes
//   the cue ball into a ball (or a ball into the cue ball) before the cue ball has hit anything, that ball is the
//   shot's first hit; a cushion it causes after the first hit counts as "a ball reached a cushion".

/**
 * The host's choices for a match.
 * @typedef {Object} MatchSettings
 * @property {'anywhere'|'behindLine'} foulRule   where the cue ball may be put after a foul
 * @property {boolean} noHitFoul   the cue ball touching no ball is a foul (default false). A state kept
 *           from before this setting existed may lack it: missing counts as false (also in the hash).
 */

/**
 * Extra fields on GameState when mode is 'match'. All plain data, all part of the hash.
 * @typedef {Object} MatchState
 * @property {'match'} mode
 * @property {MatchSettings} settings
 * @property {'aim'|'rolling'|'place'|'over'} phase      'over' once somebody has won
 * @property {0|1} turn              whose shot it is (player 0 or player 1)
 * @property {0|1} breaker           who broke (or breaks) this rack
 * @property {boolean} breakShot     the next shot is the break
 * @property {('open'|'solid'|'stripe')[]} groups   per player; both 'open' until groups are given out
 * @property {boolean} placeBehindLine   while phase is 'place': the cue ball may only go behind the line
 * @property {number} winner         -1 while playing, else 0 or 1
 * @property {''|'eight'|'eightEarly'|'eightOnFoul'|'eightOffTable'} overReason
 * @property {''|'scratch'|'cueOffTable'|'noHit'|'wrongBall'|'noCushion'|'ballOffTable'} lastFoul
 *           the foul of the last finished shot, '' if it was clean (for the small text line)
 * @property {Object} shot           what has happened during the shot now rolling (kept in the state so a
 *           game can be saved, sent and replayed in the middle of a roll): firstHit (ball id or -1),
 *           cushionAfterHit (boolean), potted (ball ids in order), off (ball ids), cuePotted, cueOff
 */

/**
 * createGame options for a match:
 *   { size, seed, mode: 'match', foulRule: 'anywhere'|'behindLine', noHitFoul?: boolean, breaker?: 0|1 }
 * noHitFoul is false unless it is exactly true.
 * Without `breaker` the first break is a coin flip from the seed.
 *
 * A match has no extra actions of its own: 'place', 'shoot' and 'nudge' as in practice ('nudgeSetting' is ignored). (The 'call' action for the 8's
 * pocket was removed 2026-11-23, HANDOFF item 38; a state kept from before may still carry a
 * calledPocket field, which is ignored: not copied by cloneState and not in the hash.)
 * A 'place' action obeys placeBehindLine. canPlaceCue() answers for the current state.
 *
 * Extra events in a match (GameEvent.type):
 *   'foul'      { player, reason }             reason as in lastFoul
 *   'turn'      { player }                     it is now this player's shot (also sent when the same player goes on)
 *   'groups'    { player, group }              this player now has 'solid' or 'stripe' (the other has the other)
 *   'rerack'    { reason }                     the 8 dropped ('eightDown') or left the table ('eightOffTable')
 *                                              on the break; the balls are racked again
 *   'gameOver'  { winner, reason }             reason as in overReason
 * These come in the same tick as 'settled'.
 *
 * Helper: shooterTarget(state) -> 'open' | 'solid' | 'stripe' | 'eight'   what the player to shoot must hit first.
 * Helper: ballsLeft(state, player) -> number   balls of that player's group still on the table (7 while open).
 */

// Added with the match code (rules/match.js), on top of the contract above:
// - state.shot also has `pottedPockets` (the pocket of each ball in `potted`, same order) and `target`
//   (what the shooter had to hit first when the shot was played, as shooterTarget gave it; '' before the first shot).
// - The cue ball in hand has where 'potted' (pocket -1 when it was taken up from the table, or the pocket it
//   dropped in) or 'off'. Its x, z stay as a hint: the head spot at the start and after a rerack.
// - Behind the line for placing: the cue ball's centre on or behind the line (z >= lineZ).
// - shooterTarget gives 'eight' on an open table that has no solids and no stripes left on it.
// - When one shot has several fouls, lastFoul names the first of: scratch, cueOffTable, noHit, wrongBall,
//   ballOffTable, noCushion.
// - The 'foul' and 'turn' events come after a foul; a game-ending shot sends 'foul' (if any) then 'gameOver';
//   a rerack sends only 'rerack'.

export {};
