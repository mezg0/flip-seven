# Favour of Olympus Web Game — Rules and Logic Specification

Status: base-game reference. For the custom Greek-god version, `GOD_CARDS_GAME_LOGIC.md` is canonical and replaces this document's Action Card rules, deck total, duplicate protection, Flip Three handling, scoring additions, and related tests.

> Do not implement the Action Card sections below for the Greek-god version. Use [GOD_CARDS_GAME_LOGIC.md](./GOD_CARDS_GAME_LOGIC.md) for all special-card behavior and edge-case resolution.

This document describes the mechanics of Favour of Olympus and its original visual identity.

## 1. Game objective

Players accumulate points over multiple rounds. During a round, a player collects number and modifier cards. A player may stay and bank the round's value, or hit and risk drawing a duplicate number. A duplicate number makes that player bust and score zero for the round unless they have a Second Chance.

A round ends when:

1. No active players remain; or
2. A player has seven unique number cards. This is a Favour of Olympus and ends the round immediately.

After scoring a completed round, the game ends if there is one unique highest-scoring player and that player's total is at least 200. If the highest total is tied, all players continue into another round.

## 2. Deck definition

The deck has 94 cards.

### Number cards: 79

- One `0` card.
- For every value `n` from 1 through 12, exactly `n` copies of value `n`.

The `0` is a number card. It scores zero, can cause a duplicate bust, and counts toward seven unique number cards.

```ts
function createNumberCards(): Card[] {
  const cards: Card[] = [{ id: uniqueId(), kind: "number", value: 0 }];

  for (let value = 1; value <= 12; value++) {
    for (let copy = 0; copy < value; copy++) {
      cards.push({ id: uniqueId(), kind: "number", value });
    }
  }

  return cards;
}
```

### Action cards: 9

- 3 `freeze`
- 3 `flipThree`
- 3 `secondChance`

### Score modifier cards: 6

- One each of `+2`, `+4`, `+6`, `+8`, and `+10`
- One `x2`

```ts
function createDeck(): Card[] {
  return shuffle([
    ...createNumberCards(),
    ...copies(3, () => actionCard("freeze")),
    ...copies(3, () => actionCard("flipThree")),
    ...copies(3, () => actionCard("secondChance")),
    modifierCard("add", 2),
    modifierCard("add", 4),
    modifierCard("add", 6),
    modifierCard("add", 8),
    modifierCard("add", 10),
    modifierCard("multiply", 2),
  ]);
}
```

Every physical card needs a unique `id`. Two number cards with the same value are still different card objects.

## 3. Core data model

Use server-authoritative state for online multiplayer. Clients send intentions such as `HIT`, `STAY`, or `SELECT_TARGET`; the server validates and applies them.

```ts
type GamePhase =
  | "lobby"
  | "initialDeal"
  | "awaitingTurnChoice"
  | "awaitingActionTarget"
  | "resolvingCards"
  | "roundScoring"
  | "gameOver";

type PlayerRoundStatus = "active" | "stayed" | "frozen" | "busted";

type Card =
  | { id: string; kind: "number"; value: number }
  | { id: string; kind: "modifier"; operation: "add"; value: 2 | 4 | 6 | 8 | 10 }
  | { id: string; kind: "modifier"; operation: "multiply"; value: 2 }
  | { id: string; kind: "action"; action: "freeze" | "flipThree" | "secondChance" };

interface PlayerState {
  id: string;
  name: string;
  seat: number;
  totalScore: number;
  roundStatus: PlayerRoundStatus;
  numberCards: Array<Extract<Card, { kind: "number" }>>;
  modifierCards: Array<Extract<Card, { kind: "modifier" }>>;
  hasSecondChance: boolean;
  // Action cards stay visible for history/animation but do not score.
  actionCardsInFront: Array<Extract<Card, { kind: "action" }>>;
  // Set when staying or freezing. It is not added to totalScore until scoreRound().
  lockedRoundScore: number | null;
}

interface PendingAction {
  cardId: string;
  action: "freeze" | "flipThree" | "secondChanceTransfer";
  chooserId: string;       // player who was dealt the action card
  targetId: string | null; // null while waiting for selection
  source: "normalDraw" | "initialDeal" | "flipThree";
}

interface FlipThreeContext {
  targetId: string;
  cardsRemaining: number;
  queuedActions: PendingAction[];
}

interface GameState {
  id: string;
  phase: GamePhase;
  players: PlayerState[];
  dealerSeat: number;
  currentTurnSeat: number | null;
  drawPile: Card[];
  discardPile: Card[];
  roundNumber: number;
  initialDealSeatsRemaining: number[];
  pendingAction: PendingAction | null;
  flipThreeStack: FlipThreeContext[];
  favourOfOlympusPlayerId: string | null;
  winnerId: string | null;
  eventLog: GameEvent[];
  revision: number;
}
```

`flipThreeStack` supports nested Flip Three cards. An iterative command queue is also valid and can be easier to persist than a literal stack.

## 4. Commands and validation

The browser should only be able to submit these gameplay commands:

```ts
type GameCommand =
  | { type: "START_GAME"; actorId: string }
  | { type: "HIT"; actorId: string; expectedRevision: number }
  | { type: "STAY"; actorId: string; expectedRevision: number }
  | { type: "SELECT_ACTION_TARGET"; actorId: string; targetId: string; expectedRevision: number };
```

Global validation for every command:

- The actor is a player in the game.
- The command is allowed in the current phase.
- `expectedRevision === state.revision`; otherwise reject stale/double-clicked input.
- A player cannot issue another decision while card animations are running. Animations must not determine rules; the server state does.

### `HIT`

Valid only when:

- `phase === "awaitingTurnChoice"`
- The actor occupies `currentTurnSeat`
- The actor is `active`

Effect: draw and resolve one card for the actor. After every resulting action has resolved, advance to the next active player unless the round ended.

### `STAY`

Valid only when:

- `phase === "awaitingTurnChoice"`
- The actor occupies `currentTurnSeat`
- The actor is `active`
- The actor has at least one card in front of them

Effect:

```ts
player.roundStatus = "stayed";
player.lockedRoundScore = calculateRoundScore(player, false);
checkRoundEnd();
if (roundContinues) advanceTurn();
```

Having only a modifier is enough to stay. A player with no card in front cannot stay.

### `SELECT_ACTION_TARGET`

Valid only when:

- `phase === "awaitingActionTarget"`
- `pendingAction.chooserId === actorId`
- The target is currently active

For Freeze and Flip Three, the chooser is always the player who was dealt the action card, not the dealer. The chooser may select themself or any active player. If only one active player exists, the server auto-selects that player.

For a `secondChanceTransfer`, the chooser is the player who was dealt a second Second Chance. Its targets are restricted to other active players who do not already have one; the chooser cannot keep the second copy.

## 5. Card resolution

All routes that reveal a card must call one canonical function. Do not duplicate this logic between initial dealing, a normal hit, and Flip Three.

```ts
type DrawSource = "initialDeal" | "normalDraw" | "flipThree";

function resolveDraw(recipientId: string, source: DrawSource): ResolutionResult {
  const card = drawCard();
  emit({ type: "CARD_REVEALED", recipientId, card, source });

  switch (card.kind) {
    case "number":
      return resolveNumberCard(recipientId, card);
    case "modifier":
      return resolveModifierCard(recipientId, card);
    case "action":
      return resolveActionCard(recipientId, card, source);
  }
}
```

### Drawing from the deck

```ts
function drawCard(): Card {
  if (state.drawPile.length === 0) {
    if (state.discardPile.length === 0) throw new Error("No drawable cards");
    state.drawPile = shuffle(state.discardPile);
    state.discardPile = [];
    emit({ type: "DECK_RESHUFFLED" });
  }

  return state.drawPile.pop()!;
}
```

When reshuffling in the middle of a round, never collect cards in front of any player, including busted players. Only shuffle the discard pile. A seeded random-number generator should be injectable for repeatable tests and match replays.

### Number card

```ts
function resolveNumberCard(playerId: string, card: NumberCard): ResolutionResult {
  const player = getPlayer(playerId);
  const isDuplicate = player.numberCards.some(c => c.value === card.value);

  if (isDuplicate && player.hasSecondChance) {
    player.hasSecondChance = false;
    moveSecondChanceAndCardToDiscard(card);
    emit({ type: "SECOND_CHANCE_USED", playerId, duplicateValue: card.value });
    return { outcome: "survivedDuplicate" };
  }

  if (isDuplicate) {
    player.numberCards.push(card); // retain visibly until the round is cleaned up
    player.roundStatus = "busted";
    player.lockedRoundScore = 0;
    emit({ type: "PLAYER_BUSTED", playerId, duplicateValue: card.value });
    return { outcome: "busted" };
  }

  player.numberCards.push(card);

  if (countUniqueNumbers(player) === 7) {
    state.favourOfOlympusPlayerId = playerId;
    emit({ type: "FAVOUR_OF_OLYMPUS_ACHIEVED", playerId });
    return { outcome: "favourOfOlympus" };
  }

  return { outcome: "resolved" };
}
```

Second Chance is automatic; the player does not choose whether to spend it. It only prevents a duplicate-number bust. It cannot prevent Freeze.

When Second Chance is used, both the duplicate number and Second Chance are discarded. The player's existing copy of that number remains.

### Modifier card

```ts
function resolveModifierCard(playerId: string, card: ModifierCard) {
  getPlayer(playerId).modifierCards.push(card);
  return { outcome: "resolved" };
}
```

Modifiers never bust and do not count toward Favour of Olympus.

### Second Chance card

```ts
function resolveSecondChance(recipientId: string, card: SecondChanceCard) {
  const recipient = getPlayer(recipientId);

  if (!recipient.hasSecondChance) {
    recipient.hasSecondChance = true;
    recipient.actionCardsInFront.push(card);
    return { outcome: "resolved" };
  }

  const eligible = activePlayers().filter(p =>
    p.id !== recipientId && !p.hasSecondChance
  );

  if (eligible.length === 0) {
    state.discardPile.push(card);
    return { outcome: "discarded" };
  }

  // Pause with pendingAction.action = "secondChanceTransfer".
  // The target must be another active player without Second Chance.
  return promptForSecondChanceRecipient(recipientId, card, eligible);
}
```

If a player receives a second Second Chance, they must give it to another active player who does not have one. If nobody qualifies, discard it. A transferred Second Chance belongs to the receiving player.

### Freeze

The player dealt the Freeze chooses any active target. On resolution:

```ts
function resolveFreeze(targetId: string, card: FreezeCard) {
  const target = requireActivePlayer(targetId);
  target.actionCardsInFront.push(card);
  target.roundStatus = "frozen";
  target.lockedRoundScore = calculateRoundScore(target, false);
  emit({ type: "PLAYER_FROZEN", targetId, score: target.lockedRoundScore });
  checkRoundEnd();
}
```

Freeze banks the target's current points and removes them from the round. Second Chance has no effect on Freeze.

### Flip Three

The player dealt Flip Three chooses any active target. The target must accept the next three cards, revealed one at a time.

Stop early if the target busts or any player achieves Favour of Olympus. Otherwise all three revealed cards count, including number, modifier, and action cards.

Important action timing inside Flip Three:

- A revealed Second Chance resolves immediately, because it may protect against a duplicate among the remaining forced draws.
- A revealed Freeze or Flip Three is added to a FIFO queue.
- Finish the current three forced draws before resolving queued Freeze/Flip Three cards.
- If the forced target busts, abandon their queued Freeze/Flip Three effects without resolving them. Keep those physical cards in the busted player's in-play area until round cleanup; they must not become eligible for a mid-round reshuffle.
- If Favour of Olympus occurs, abandon every unresolved action because the round ends immediately.
- Resolve queued actions in reveal order. Each action's dealt player chooses its target when that queued action reaches the front.

```ts
function resolveFlipThree(targetId: string, card: FlipThreeCard) {
  requireActivePlayer(targetId).actionCardsInFront.push(card);
  const context: FlipThreeContext = {
    targetId,
    cardsRemaining: 3,
    queuedActions: [],
  };
  state.flipThreeStack.push(context);
  continueFlipThree(context);
}

function continueFlipThree(context: FlipThreeContext) {
  while (context.cardsRemaining > 0) {
    if (roundHasFavourOfOlympus()) return endRoundImmediately();
    if (!isActive(context.targetId)) return abandonQueuedActionsInPlay(context);

    context.cardsRemaining--;
    const card = drawCard();
    emit({ type: "CARD_REVEALED", recipientId: context.targetId, card, source: "flipThree" });

    if (card.kind === "action" && card.action !== "secondChance") {
      context.queuedActions.push({
        cardId: card.id,
        action: card.action,
        chooserId: context.targetId,
        targetId: null,
        source: "flipThree",
      });
      continue;
    }

    const result = resolveAlreadyDrawnCard(context.targetId, card, "flipThree");
    if (result.outcome === "favourOfOlympus") return endRoundImmediately();
    if (result.outcome === "busted") return abandonQueuedActionsInPlay(context);
    if (result.requiresInput) return; // resume here after target selection
  }

  state.flipThreeStack.pop();
  resolveQueuedActionsInOrder(context.queuedActions);
}
```

Do not implement Flip Three as three calls to the normal turn function: forced draws do not allow Hit/Stay decisions and have different action timing.

## 6. Initial deal

At the start of a round:

1. Reset every player's round fields and set them to `active`.
2. Set the deal order to every seat beginning with the dealer and moving left/clockwise.
3. Deal one card face up to each player in order.
4. If an action appears, pause the deal, resolve the entire action chain, then resume at the next undealt seat.
5. If Favour of Olympus occurs during an action chain, end the round immediately.
6. After the initial deal completes, begin turn choices with the dealer, or the next active seat if the dealer is no longer active.

Implementation policy for a rare edge case: if a player is frozen or busted by an action before their scheduled initial card, skip their scheduled initial deal because they are no longer active. Record this as an explicit product rule and cover it with a test; the printed rules do not spell out this exact timing.

```ts
function continueInitialDeal() {
  while (state.initialDealSeatsRemaining.length > 0) {
    if (roundShouldEnd()) return beginRoundScoring();

    const seat = state.initialDealSeatsRemaining.shift()!;
    const player = playerAt(seat);
    if (player.roundStatus !== "active") continue;

    const result = resolveDraw(player.id, "initialDeal");
    if (result.requiresInput || result.isResolvingChain) return;
  }

  startTurnAtOrAfter(state.dealerSeat);
}
```

Because an action card can be played on another player, the player originally dealt it may still have no card in front afterward and therefore cannot choose Stay yet.

## 7. Turn order and gameplay loop

Only active players receive turns. Stayed, frozen, and busted players are skipped.

```ts
function advanceTurn() {
  if (roundShouldEnd()) return beginRoundScoring();

  const next = findNextActiveSeat(state.currentTurnSeat!);
  if (next === null) return beginRoundScoring();

  state.currentTurnSeat = next;
  state.phase = "awaitingTurnChoice";
  emit({ type: "TURN_STARTED", playerId: playerAt(next).id });
}
```

End-to-end gameplay loop:

```text
create game and seat players
  -> build and thoroughly shuffle deck
  -> choose dealer
  -> start round
       -> reset player round state
       -> initial deal from dealer seat
            -> reveal one card per active player
            -> pause and fully resolve actions when necessary
       -> start dealer's decision turn
       -> while round is not over
            -> current active player chooses HIT or STAY
            -> if STAY: lock score; mark stayed
            -> if HIT: reveal one card
                 -> number: keep, spend Second Chance, bust, or Favour of Olympus
                 -> modifier: keep
                 -> action: chooser selects active target; resolve effect
            -> finish all nested/queued effects
            -> if Favour of Olympus: end immediately
            -> if no active players: end
            -> otherwise advance to next active seat
       -> calculate and add every player's round score
       -> move all in-play cards to discard
       -> if unique leader has at least 200: game over
       -> otherwise rotate dealer left and start next round
```

## 8. Round termination

```ts
function roundShouldEnd(): boolean {
  return state.favourOfOlympusPlayerId !== null || activePlayers().length === 0;
}
```

Favour of Olympus is an immediate interrupt. Once it occurs:

- Do not reveal any remaining Flip Three cards.
- Do not resolve queued actions.
- Do not continue the initial deal.
- Do not offer another turn.
- Proceed directly to scoring.

When a player busts, only that player becomes inactive. When a player stays or is frozen, that player banks points and becomes inactive. The other active players continue.

## 9. Scoring

Scoring order is mandatory:

1. Sum number cards.
2. If the player has `x2`, multiply only the number-card sum by two.
3. Add all `+N` modifiers.
4. Add 15 only to the player who achieved Favour of Olympus.

```ts
function calculateRoundScore(player: PlayerState, achievedFavourOfOlympus: boolean): number {
  if (player.roundStatus === "busted") return 0;

  const numberTotal = player.numberCards.reduce((sum, card) => sum + card.value, 0);
  const hasX2 = player.modifierCards.some(card => card.operation === "multiply");
  const addTotal = player.modifierCards
    .filter((card): card is AddModifierCard => card.operation === "add")
    .reduce((sum, card) => sum + card.value, 0);

  return numberTotal * (hasX2 ? 2 : 1) + addTotal + (achievedFavourOfOlympus ? 15 : 0);
}
```

Examples:

- Numbers `11 + 5 + 12` and `+4` score `32`.
- Numbers totaling `36` and `x2` score `72`.
- Numbers totaling `36`, `x2`, and `+10` score `82`, not `92`.
- Only `+8` scores `8`.
- Only `x2` scores `0`.
- A busted player scores `0` regardless of modifiers.

At round end, recompute scores from the canonical cards instead of trusting a client or cached display value. `lockedRoundScore` exists to communicate that a stayed/frozen player's result cannot change; it should equal the recomputed value.

```ts
function scoreRound() {
  for (const player of state.players) {
    const score = calculateRoundScore(
      player,
      player.id === state.favourOfOlympusPlayerId
    );
    player.totalScore += score;
    emit({ type: "ROUND_SCORE_AWARDED", playerId: player.id, score });
  }
}
```

## 10. Cleanup, deck continuity, and next round

Do not rebuild or reshuffle the full deck every round.

1. Move all cards used in the round to the discard pile, including unused Second Chance cards and cards in front of busted players.
2. Keep the remaining draw pile in its current order.
3. Move the dealer one seat left/clockwise.
4. Start the next round using the remaining draw pile.
5. Whenever a draw is required and the draw pile is empty, shuffle the discard pile to form a new draw pile.

Used Second Chance cards and their canceled duplicate number enter the discard pile as soon as they are spent. Unresolved action cards also go to the discard pile when abandoned.

```ts
function prepareNextRound() {
  collectAllInPlayCardsIntoDiscard();
  state.dealerSeat = nextSeat(state.dealerSeat);
  state.roundNumber++;
  resetRoundFields();
  startInitialDeal();
}
```

## 11. Winning and ties

Check for a winner only after an entire round has been scored.

```ts
function findWinner(players: PlayerState[], targetScore = 200): PlayerState | null {
  const highScore = Math.max(...players.map(p => p.totalScore));
  if (highScore < targetScore) return null;

  const leaders = players.filter(p => p.totalScore === highScore);
  return leaders.length === 1 ? leaders[0] : null;
}
```

If two or more players tie for the highest score at or above 200, all players—not only the tied players—continue playing full rounds until there is one unique leader.

## 12. Recommended reducer/API boundaries

Keep rule logic separate from transport, persistence, and animation.

```ts
// Pure or nearly pure domain operations
createGame(players, seed)
startRound(state)
validateCommand(state, command)
applyCommand(state, command)
resolveDraw(state, recipientId, source)
resolveNumberCard(state, playerId, card)
resolveModifierCard(state, playerId, card)
resolveActionCard(state, chooserId, card, source)
resolveFreeze(state, targetId, card)
resolveFlipThree(state, targetId, card)
calculateRoundScore(player, achievedFavourOfOlympus)
checkRoundEnd(state)
scoreRound(state)
findWinner(players, targetScore)
prepareNextRound(state)

// Multiplayer/application layer
joinGame(gameId, userId)
submitCommand(gameId, command)
saveSnapshot(state)
broadcastEvents(gameId, events)
reconnectPlayer(gameId, userId)
```

`applyCommand` should return `{ nextState, events }`. The UI animates the returned events in order. This prevents visual timing from corrupting rules and permits reconnecting clients to load a snapshot and replay later events.

Suggested public information: the entire deck is face-down, but all revealed/in-front cards, player statuses, total scores, current turn, and remaining card count are visible to everyone. Never send the draw pile's card order to clients.

## 13. Event types for UI and replay

Useful domain events include:

```ts
type GameEvent =
  | { type: "ROUND_STARTED"; round: number; dealerId: string }
  | { type: "CARD_REVEALED"; recipientId: string; card: Card; source: DrawSource }
  | { type: "ACTION_TARGET_REQUESTED"; chooserId: string; action: string; eligibleTargetIds: string[] }
  | { type: "ACTION_TARGETED"; chooserId: string; targetId: string; action: string }
  | { type: "SECOND_CHANCE_USED"; playerId: string; duplicateValue: number }
  | { type: "PLAYER_BUSTED"; playerId: string; duplicateValue: number }
  | { type: "PLAYER_STAYED"; playerId: string; score: number }
  | { type: "PLAYER_FROZEN"; targetId: string; score: number }
  | { type: "FLIP_THREE_STARTED"; targetId: string }
  | { type: "FAVOUR_OF_OLYMPUS_ACHIEVED"; playerId: string }
  | { type: "TURN_STARTED"; playerId: string }
  | { type: "ROUND_SCORE_AWARDED"; playerId: string; score: number }
  | { type: "DECK_RESHUFFLED" }
  | { type: "GAME_WON"; playerId: string; totalScore: number };
```

## 14. Minimum test plan

### Deck tests

- Deck contains exactly 94 unique card IDs.
- Number counts are correct for 0 through 12.
- There are three copies of each action and one of each modifier.
- Seeded shuffle is deterministic.

### Number and Second Chance tests

- A new number is added normally.
- A duplicate busts and scores zero.
- Duplicate zero also busts.
- Second Chance discards itself and the duplicate, retaining the original.
- After Second Chance is spent, the player does not immediately draw again.
- A second Second Chance transfers only to an active player without one.
- A second Second Chance is discarded when no eligible recipient exists.
- Second Chance does not prevent Freeze.

### Action tests

- The dealt player—not the dealer—chooses the action target.
- The chooser may target themself.
- The sole active player is auto-targeted.
- Freeze locks the current score and makes the target inactive.
- Flip Three counts modifiers and actions among its three cards.
- Flip Three stops on bust.
- Flip Three stops on Favour of Olympus.
- Second Chance drawn during Flip Three can protect a later forced draw.
- Freeze and Flip Three drawn during Flip Three wait until all forced draws finish.
- Multiple queued actions resolve in reveal order.
- Queued actions are abandoned if their forced target busts.
- Nested Flip Three resolves without allowing Hit/Stay decisions between forced cards.

### Turn and round tests

- Dealer is first in initial deal and first offered a turn when active.
- Inactive players are skipped.
- A no-card player cannot stay.
- A modifier-only player can stay and score the modifier.
- All inactive players ends the round.
- Seven unique numbers ends the round immediately, including during initial deal or Flip Three.
- No commands are accepted while an action target is pending except the expected selection.

### Scoring and game-end tests

- Scoring follows `(number sum * x2) + additive modifiers + Favour of Olympus bonus`.
- `x2` does not double additive modifiers or the 15-point bonus.
- Only the Favour of Olympus achiever gets 15 points.
- Bust always scores zero.
- A unique leader below 200 does not win.
- A unique leader at or above 200 wins.
- A top-score tie at or above 200 continues the game with all players.

### Deck lifecycle tests

- Cards from a round go to discard rather than immediately back into the deck.
- Empty draw pile reshuffles only discard cards.
- In-play cards, including busted players' cards, are not reshuffled mid-round.
- Dealer rotates one seat after each round.

## 15. Explicit product decisions to keep configurable

The following are not changes to the core rules, but should be configuration rather than scattered constants:

```ts
interface GameConfig {
  targetScore: number;             // official default: 200
  minimumPlayers: number;          // official packaging: 3
  actionChoiceTimeoutMs: number;   // online-only behavior
  turnChoiceTimeoutMs: number;     // online-only behavior
  disconnectedPlayerPolicy: "pause" | "autoStay" | "bot";
}
```

Timeout/disconnection behavior is not specified by the tabletop rules. Choose and display it before a match. A safe default is to pause private games and auto-stay timed public games when staying is legal; if a no-card player times out, the server must hit or replace them with a bot because Stay is illegal.

## Sources
