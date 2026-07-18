# God Cards Game Logic Specification

Status: canonical rules layer for the Greek-god variant. This document replaces the Action Card, Second Chance, Freeze, and Flip Three rules in `GAME_LOGIC_SPEC.md`. The base number-card rules, modifier rules, turn order, round structure, scoring target, deck continuity, and server-authoritative architecture still apply unless overridden here.

## 1. Assumptions and terminology

The proposed deck contains:

- 79 Number Cards: one `0`, and `n` copies of every value `n` from 1 through 12.
- 6 Modifier Cards: `+2`, `+4`, `+6`, `+8`, `+10`, and `x2`.
- 12 God Cards: one copy of each God listed below.
- 97 cards in total.

If multiple physical copies of a God are added later, the rules below still work. Effects copied by Prometheus or duplicated by Aphrodite can already create multiple instances of some powers.

The submitted name “Dyonisus” is represented in code as `dionysus`; the UI display name can preserve the preferred spelling.

Definitions:

- **Controller**: the player who drew or received the God Card and makes its choices.
- **Target**: a player or card affected by the power.
- **Active player**: a player who has not stayed or busted this round.
- **Physical card**: one of the 97 cards that moves among draw pile, resolving zone, table, and discard pile.
- **Effect token**: a generated round-only effect created when a power is copied or shared without moving another physical card.
- **Atomic effect**: an operation whose duplicate checks and Favour of Olympus checks must finish for every affected player before the round can end.

Unlike the original Action Cards, every God Card revealed during Ares resolves fully. It is not merely counted and deferred.

## 2. God catalog

```ts
type GodKind =
  | "zeus"
  | "ares"
  | "dionysus"
  | "athena"
  | "hades"
  | "hermes"
  | "artemis"
  | "aphrodite"
  | "hephaestus"
  | "demeter"
  | "nike"
  | "prometheus";

type Card =
  | { id: string; kind: "number"; value: number }
  | { id: string; kind: "modifier"; operation: "add"; value: 2 | 4 | 6 | 8 | 10 }
  | { id: string; kind: "modifier"; operation: "multiply"; value: 2 }
  | { id: string; kind: "god"; god: GodKind };

type DrawSource = "initialDeal" | "normalDraw" | "ares" | "aphrodite";
```

The list contains Zeus, Ares, Dionysus, Athena, Hades, Hermes, Artemis, Aphrodite, Hephaestus, Demeter, Nike, and Prometheus. With one of each, the total is:

```text
79 Number + 6 Modifier + 12 God = 97 cards
```

`createDeck()` and tests must assert 97.

```ts
const GODS: GodKind[] = [
  "zeus", "ares", "dionysus", "athena", "hades", "hermes",
  "artemis", "aphrodite", "hephaestus", "demeter", "nike", "prometheus",
];

function createDeck(): Card[] {
  return shuffle([
    ...createNumberCards(),
    modifierCard("add", 2),
    modifierCard("add", 4),
    modifierCard("add", 6),
    modifierCard("add", 8),
    modifierCard("add", 10),
    modifierCard("multiply", 2),
    ...GODS.map(god => godCard(god)),
  ]);
}
```

## 3. State additions

Use number and modifier **instances**, because Aphrodite creates temporary copies of a card’s value/effect without cloning the physical deck card.

```ts
interface NumberInstance {
  instanceId: string;
  value: number;
  physicalCardId: string | null;
  origin: "deck" | "aphrodite";
}

interface ModifierInstance {
  instanceId: string;
  operation: "add" | "multiply";
  value: number;
  physicalCardId: string | null;
  origin: "deck" | "aphrodite" | "hephaestusFallback";
}

interface PersistentGodEffect {
  effectId: string;
  kind: "zeus" | "demeter" | "nike";
  ownerId: string;
  physicalCardId: string | null;
  grantedBy: GodKind; // the actual card, e.g. "prometheus" copying "nike"
}

interface GodResolutionRecord {
  god: GodKind;
  controllerId: string;
  copiedGod: GodKind | null;
  completedAtSequence: number;
}

interface AresFrame {
  controllerId: string;
  targetId: string;
  cardsRemaining: number;
}

interface PlayerState {
  id: string;
  roundStatus: "active" | "stayed" | "busted";
  numberCards: NumberInstance[];
  modifierCards: ModifierInstance[];
  godEffects: PersistentGodEffect[];
  lockedRoundScore: number | null;
  totalScore: number;
}

interface GodVariantState {
  resolvingCards: Card[];
  resolutionStack: Array<GodResolutionFrame | AresFrame>;
  pendingChoice: PendingChoice | null;
  godResolutionHistory: GodResolutionRecord[];
  favourOfOlympusPlayerIds: string[];
  roundEndRequested: boolean;
}
```

`favourOfOlympusPlayerIds` is an array, not a single ID. Aphrodite can give the same Number Card to two players simultaneously, allowing both to achieve Favour of Olympus in one atomic effect.

## 4. Resolution engine

Every revealed card enters a resolving zone before its effect begins. It cannot be selected from the discard pile while still resolving.

```ts
function revealAndResolve(recipientId: string, source: DrawSource): ResolutionResult {
  const card = drawCard();
  state.resolvingCards.push(card);
  emit({ type: "CARD_REVEALED", recipientId, card, source });

  switch (card.kind) {
    case "number":
      return resolveNumberInstancesAtomically([
        deckNumberInstance(card, recipientId),
      ]);

    case "modifier":
      givePhysicalModifier(recipientId, card);
      removeFromResolving(card.id);
      return { outcome: "resolved" };

    case "god":
      return beginGodResolution(card.god, recipientId, card.id, {
        persistentCardPolicy: "keepPhysicalWhenNeeded",
        recordHistory: true,
      });
  }
}
```

God resolution rules:

1. Push a resolution frame.
2. Collect and validate every required choice.
3. Apply the effect.
4. Resolve all resulting duplicate checks.
5. Recalculate Demeter attachments.
6. Detect Favour of Olympus for all affected active players.
7. Finish or discard the physical God Card as specified.
8. Pop the frame and append the God to resolution history.
9. If `roundEndRequested`, abandon future draws and unwind the remaining frames without starting new effects.

Round termination is delayed until the current atomic effect finishes. For example, Aphrodite must resolve duplicate outcomes for both targets before a simultaneous Favour of Olympus ends the round.

### Choice system

Use a server-created choice ID rather than adding one command type per God.

```ts
type PendingChoice =
  | { id: string; kind: "choosePlayers"; controllerId: string; min: number; max: number; eligiblePlayerIds: string[]; distinct: boolean }
  | { id: string; kind: "choosePlayerNumber"; controllerId: string; eligible: Array<{ playerId: string; instanceIds: string[] }> }
  | { id: string; kind: "chooseHermesExchange"; controllerId: string; eligible: Array<{ playerId: string; instanceIds: string[] }> }
  | { id: string; kind: "chooseDiscardNumber"; controllerId: string; physicalCardIds: string[] }
  | { id: string; kind: "chooseDiscardModifier"; controllerId: string; physicalCardIds: string[] }
  | { id: string; kind: "reorderDeckTop"; controllerId: string; physicalCardIds: string[] };

type ChoiceCommand = {
  type: "SUBMIT_CHOICE";
  actorId: string;
  choiceId: string;
  selection: unknown;
  expectedRevision: number;
};
```

The server must validate IDs against `pendingChoice`. Never accept arbitrary player IDs, card IDs, values, or deck ordering from the client.

## 5. Shared duplicate and Favour of Olympus handling

All ways of receiving a Number Card—normal hit, Hades, Hermes, Ares, and Aphrodite—must use one duplicate resolver.

```ts
function resolveIncomingNumber(playerId: string, incoming: NumberInstance): NumberOutcome {
  const player = requireActivePlayer(playerId);
  const duplicate = player.numberCards.some(card => card.value === incoming.value);

  if (!duplicate) {
    player.numberCards.push(incoming);
    return "accepted";
  }

  const zeus = player.godEffects.find(effect => effect.kind === "zeus");
  if (zeus) {
    removeGodEffect(player, zeus);
    discardPersistentGodPhysicalCardIfAny(zeus);
    discardOrDestroyNumberInstance(incoming);
    emit({ type: "ZEUS_TRIGGERED", playerId, duplicateValue: incoming.value });
    return "protectedByZeus";
  }

  player.numberCards.push(incoming); // retained visibly until cleanup
  player.roundStatus = "busted";
  player.lockedRoundScore = 0;
  emit({ type: "PLAYER_BUSTED", playerId, duplicateValue: incoming.value });
  return "busted";
}
```

For multi-player effects:

```ts
function finishAtomicNumberChanges(affectedPlayerIds: string[]) {
  for (const id of unique(affectedPlayerIds)) recalculateDemeter(id);

  const achievers = unique(affectedPlayerIds).filter(id =>
    isActive(id) && countUniqueNumbers(getPlayer(id)) >= 7
  );

  for (const id of achievers) addFavourOfOlympusAchiever(id);
  if (achievers.length > 0) state.roundEndRequested = true;
}
```

Zeus protects against one incoming duplicate and is then removed. If a malformed or future effect creates two duplicates for one player simultaneously, Zeus prevents only the first deterministic incoming card; any remaining duplicate busts the player.

## 6. Individual God logic

### Zeus — Divine Protection

Effect: create one persistent Zeus protection for the controller.

```ts
function resolveZeus(ctx: GodContext) {
  const player = getPlayer(ctx.controllerId);
  const alreadyProtected = player.godEffects.some(effect => effect.kind === "zeus");

  if (alreadyProtected) return finishGodWithNoEffect(ctx);

  addPersistentEffect(player.id, {
    kind: "zeus",
    physicalCardId: ctx.canKeepPhysicalCard ? ctx.physicalCardId : null,
    grantedBy: ctx.actualGod,
  });
  finishGod(ctx, { keepPhysicalCard: ctx.canKeepPhysicalCard });
}
```

Rules and edge cases:

- Zeus triggers automatically on a duplicate; it is not optional.
- Discard/destroy the incoming duplicate, not the player's existing number.
- Zeus does not prevent Dyonisus from making the player stay.
- A player may have only one Zeus protection. A second Zeus or copied Zeus has no effect and its physical card is discarded.
- If Zeus came from Prometheus or Aphrodite, protection is represented by an effect token because the physical Zeus card is not retained.
- Unused Zeus protection ends at round cleanup.

### Ares — Reckless Assault

Effect: the controller chooses any one active player, including themself. That target resolves up to three sequential draws.

```ts
async function resolveAres(ctx: GodContext, targetId: string) {
  requireEligibleActiveTarget(targetId);
  const frame: AresFrame = { controllerId: ctx.controllerId, targetId, cardsRemaining: 3 };
  state.resolutionStack.push(frame);

  while (frame.cardsRemaining > 0) {
    if (state.roundEndRequested || !isActive(frame.targetId)) break;

    frame.cardsRemaining--;
    const result = await revealAndResolve(frame.targetId, "ares");

    // revealAndResolve fully resolves a God, including all nested choices/effects.
    if (result.outcome === "busted" || !isActive(frame.targetId)) break;
    if (state.roundEndRequested) break;
  }

  state.resolutionStack.pop();
  finishGod(ctx);
}
```

Rules and edge cases:

- Every revealed card consumes one of the three draws, including a Modifier or God Card.
- A God Card revealed by Ares resolves immediately and completely before the next forced draw.
- The player who revealed that nested God controls it and chooses its targets.
- If the forced player busts from the drawn number or from a nested God effect, Ares stops immediately.
- If Dyonisus makes the forced player stay, Ares stops because that player is no longer active.
- If Dyonisus targets somebody else, the forced player's Ares sequence continues.
- If any atomic effect achieves Favour of Olympus, Ares stops and the round ends after the current resolution stack safely unwinds.
- If Ares reveals another Ares, resolve the nested Ares fully, then resume the parent Ares only if its original target remains active and the round has not ended.
- A Zeus-protected duplicate consumes the forced draw but does not stop Ares; continue with the remaining draws.
- If the draw pile empties between forced cards, reshuffle eligible discard cards normally. Never reshuffle cards in tableaux or the resolving stack.

### Dyonisus — Drunken Blackout

Effect: choose one active player. They immediately stay and bank their current score.

```ts
function resolveDionysus(ctx: GodContext, targetId: string) {
  const target = requireActivePlayer(targetId);
  target.roundStatus = "stayed";
  target.lockedRoundScore = calculateRoundScore(target);
  emit({ type: "PLAYER_FORCED_TO_STAY", targetId, score: target.lockedRoundScore });
  finishGod(ctx);
}
```

Rules and edge cases:

- The target must be active when selected.
- Unlike voluntary Stay, this can force a player with no number or modifier cards to stay for zero.
- Zeus cannot prevent this effect.
- The target is no longer eligible for any God effect requiring an active player.
- If this removes the last active player, finish the current God resolution, then end the round.

### Athena — Strategic Foresight

Effect: privately show the controller up to the next three drawable cards and let them return those cards to the top in any order.

```ts
function beginAthena(ctx: GodContext) {
  const cards = takeNextDrawableCardsForPeek(3);
  if (cards.length === 0) return finishGodWithNoEffect(ctx);

  requestPrivateReorder(ctx.controllerId, cards.map(card => card.id));
}

function completeAthena(ctx: GodContext, orderedIds: string[]) {
  validateExactPermutation(orderedIds, ctx.peekedCardIds);
  returnCardsToDeckTop(orderedIds); // first ID is the next card drawn
  finishGod(ctx);
}
```

Rules and edge cases:

- Only the controller receives card identities. Other clients receive a generic “Athena is choosing” event.
- If fewer than three cards are drawable, show and reorder the available cards.
- If the draw pile has fewer than three but the discard pile is available, preserve the current draw-pile cards as the first cards, shuffle the discard pile to supply the remainder, then allow all peeked cards to be reordered together.
- Cards in play or currently resolving are never included.
- On timeout or disconnection, return the cards in their original order.
- Reordering the deck does not itself resolve duplicates or Favour of Olympus.

### Hades — From the Underworld

Effect: choose a physical Number Card in the discard pile, remove it from discard, choose an active target, and give it to that player.

```ts
function resolveHades(ctx: GodContext, physicalCardId: string, targetId: string) {
  const card = requireDiscardedNumberCard(physicalCardId);
  requireActivePlayer(targetId);
  removeFromDiscard(card.id);

  const outcome = resolveIncomingNumber(targetId, physicalNumberInstance(card));
  finishAtomicNumberChanges([targetId]);
  finishGod(ctx);
  return outcome;
}
```

Rules and edge cases:

- If there are no discarded Number Cards, Hades resolves with no effect.
- Hades cannot select a Number Card in front of a player, in the draw pile, or in the resolving zone.
- The target cannot refuse the card.
- Duplicate, Zeus, Demeter, bust, and Favour of Olympus logic are identical to a normal Number draw.
- If Zeus rejects the resurrected duplicate, that physical Number Card returns to discard.
- If the target busts, the selected card remains visible in that player's tableau until round cleanup.

### Hermes — Sudden Reversal

Effect: select two distinct active players who each own at least one Number Card, select one Number Card from each, and exchange those cards simultaneously.

```ts
function resolveHermes(
  ctx: GodContext,
  left: { playerId: string; instanceId: string },
  right: { playerId: string; instanceId: string },
) {
  assert(left.playerId !== right.playerId);
  const a = requireOwnedNumber(left.playerId, left.instanceId);
  const b = requireOwnedNumber(right.playerId, right.instanceId);
  requireActivePlayer(left.playerId);
  requireActivePlayer(right.playerId);

  removeNumber(left.playerId, a.instanceId);
  removeNumber(right.playerId, b.instanceId);

  const leftOutcome = resolveIncomingNumber(left.playerId, b);
  const rightOutcome = resolveIncomingNumber(right.playerId, a);

  finishAtomicNumberChanges([left.playerId, right.playerId]);
  finishGod(ctx);
  return { leftOutcome, rightOutcome };
}
```

Rules and edge cases:

- If fewer than two active players have Number Cards, Hermes resolves with no effect.
- Player and card selections are validated again when submitted.
- The exchange is atomic: remove both outgoing cards before checking either incoming card.
- Both players can bust in the same exchange.
- Each affected player resolves their own Zeus independently.
- When Zeus prevents a duplicate, the incoming exchanged card is discarded/destroyed. The protected player does not recover the card they gave away.
- Recalculate Demeter for both players after all duplicate outcomes.
- Check Favour of Olympus only after both players' duplicate outcomes finish.
- A generated Aphrodite number can be exchanged. It remains generated and is destroyed rather than added to the physical discard pile if later discarded.

### Artemis — The Perfect Shot

Effect: select one Number Card owned by any active player, including the controller, and discard it.

```ts
function resolveArtemis(ctx: GodContext, playerId: string, instanceId: string) {
  requireActivePlayer(playerId);
  const number = requireOwnedNumber(playerId, instanceId);
  removeNumber(playerId, instanceId);
  discardOrDestroyNumberInstance(number);
  recalculateDemeter(playerId);
  finishGod(ctx);
}
```

Rules and edge cases:

- If no active player owns a Number Card, Artemis resolves with no effect.
- A physical Number Card enters discard immediately and can be selected by a later Hades.
- An Aphrodite-generated number is destroyed and never enters the physical discard pile.
- Removing a card lowers score and unique-number count.
- A round normally ends immediately once Favour of Olympus is confirmed, so Artemis cannot undo an already completed Favour of Olympus. It can remove a sixth-or-lower card before that point.
- Demeter moves to the player's new lowest card, or becomes dormant if the player has no numbers.

### Aphrodite — Irresistible Bond

Effect: choose two distinct active players, reveal one physical card, and apply it as follows.

```ts
async function resolveAphrodite(ctx: GodContext, firstId: string, secondId: string) {
  requireDistinctActivePlayers(firstId, secondId);
  const revealed = drawCardIntoResolvingZone();

  if (revealed.kind === "number") {
    const first = generatedNumberInstance(revealed, firstId);
    const second = generatedNumberInstance(revealed, secondId);
    resolveIncomingNumber(firstId, first);
    resolveIncomingNumber(secondId, second);
    movePhysicalCardToDiscard(revealed.id);
    finishAtomicNumberChanges([firstId, secondId]);
  } else if (revealed.kind === "modifier") {
    giveGeneratedModifier(firstId, revealed);
    giveGeneratedModifier(secondId, revealed);
    movePhysicalCardToDiscard(revealed.id);
  } else {
    await beginGodResolution(revealed.god, ctx.controllerId, revealed.id, {
      persistentCardPolicy: "alwaysDiscardPhysicalAndUseToken",
      recordHistory: true,
    });
    // Child resolution discards the revealed physical God after applying its effect.
  }

  finishGod(ctx);
}
```

Rules and edge cases:

- The two targets must be distinct and active when selected. The controller may be one of them.
- If fewer than two active players exist, Aphrodite resolves with no effect and does not reveal a card.
- The revealed physical card always ends in discard after its effect is applied.
- For a Number, create one temporary number instance for each target. Both count for score, duplicates, Demeter, and Favour of Olympus during the round.
- Resolve both players' duplicate/Zeus outcomes before checking Favour of Olympus.
- Both targets can bust, both can survive, or both can achieve Favour of Olympus simultaneously.
- For a Modifier, create one temporary modifier instance for each player. An `x2` remains an `x2`; multiple `x2` effects are idempotent rather than compounding to `x4`.
- For a God, resolve that God exactly once. Aphrodite's controller controls the revealed God and makes its choices.
- Persistent revealed Gods such as Zeus, Demeter, or Nike create effect tokens; their physical card still goes to discard.
- If Aphrodite reveals Aphrodite, resolve the nested Aphrodite fully. Each nested reveal consumes another physical card, so recursion is finite.
- If Aphrodite reveals Ares, Ares may create further nested resolutions. Finish them before completing Aphrodite.
- If the deck and eligible discard pile contain no drawable card, Aphrodite resolves with no revealed effect.

### Hephaestus — The Divine Forge

Effect: if the discard pile contains a Modifier Card, choose one and give it to any active player. Otherwise give the controller a generated `+4` modifier.

```ts
function resolveHephaestus(ctx: GodContext, modifierCardId?: string, targetId?: string) {
  const available = discardedModifierCards();

  if (available.length === 0) {
    giveGeneratedModifierValue(ctx.controllerId, "add", 4, "hephaestusFallback");
    return finishGod(ctx);
  }

  const modifier = requireOneOf(available, modifierCardId);
  const target = requireActivePlayer(targetId!);
  removeFromDiscard(modifier.id);
  givePhysicalModifier(target.id, modifier);
  finishGod(ctx);
}
```

Rules and edge cases:

- The fallback belongs to the controller—the player resolving Hephaestus—not a separately selected target.
- The fallback is a generated modifier instance and does not add a physical `+4` card to the deck.
- A copied Hephaestus uses the Prometheus controller for the fallback.
- If at least one discarded Modifier exists, the controller must choose one; they cannot choose the fallback instead.
- A modifier currently resolving under Aphrodite is not yet in discard and cannot be forged.
- The selected physical Modifier is removed from discard, so a later Hephaestus cannot choose it again unless it returns to discard.

### Demeter — Bountiful Harvest

Effect: choose one active player with at least one Number Card and give them a persistent Demeter blessing. Each blessing adds the value of that player's current lowest Number Card to their effective number total.

```ts
function demeterBonus(player: PlayerState): number {
  if (player.numberCards.length === 0) return 0;
  const lowest = Math.min(...player.numberCards.map(card => card.value));
  const blessingCount = player.godEffects.filter(effect => effect.kind === "demeter").length;
  return lowest * blessingCount;
}

function resolveDemeter(ctx: GodContext, targetId: string) {
  const target = requireActivePlayerWithNumber(targetId);
  addPersistentEffect(target.id, {
    kind: "demeter",
    physicalCardId: ctx.canKeepPhysicalCard ? ctx.physicalCardId : null,
    grantedBy: ctx.actualGod,
  });
  finishGod(ctx, { keepPhysicalCard: ctx.canKeepPhysicalCard });
}
```

Rules and edge cases:

- If no active player has a Number Card, Demeter resolves with no effect.
- Ties for lowest value do not require a gameplay choice because the score is identical. The UI may place the marker beside the first deterministic instance ID.
- Recalculate the marker after Hades, Hermes, Artemis, Aphrodite, or any other number change.
- If the blessed player has no numbers, Demeter is dormant and scores zero. It reattaches if that player later receives a number while still active.
- Multiple Demeter effects can exist through Prometheus/Aphrodite. Each adds the current lowest value once; two blessings make that one card contribute three times in total, not four times.
- Demeter's bonus is part of the effective number total and is doubled by `x2`.
- Demeter never adds a unique number and never counts toward Favour of Olympus.

### Nike — Glory of Victory

Effect: give the controller a persistent Nike effect. Each Nike effect awards `+10` if that player achieves Favour of Olympus this round.

```ts
function resolveNike(ctx: GodContext) {
  addPersistentEffect(ctx.controllerId, {
    kind: "nike",
    physicalCardId: ctx.canKeepPhysicalCard ? ctx.physicalCardId : null,
    grantedBy: ctx.actualGod,
  });
  finishGod(ctx, { keepPhysicalCard: ctx.canKeepPhysicalCard });
}

function nikeBonus(playerId: string): number {
  if (!hasFavourOfOlympus(playerId)) return 0;
  return getPlayer(playerId).godEffects.filter(effect => effect.kind === "nike").length * 10;
}
```

Rules and edge cases:

- Nike is not a Number or Modifier and does not count toward Favour of Olympus.
- Nike's `+10` is added after the number total, `x2`, additive modifiers, and normal `+15` Favour of Olympus bonus. It is not doubled.
- Multiple Nike effects created by copied/revealed powers each award `+10`.
- If Nike never triggers, its physical card/effect is removed during round cleanup.
- A busted player cannot trigger Nike.

### Prometheus — Stolen Fire

Effect: inspect the most recently **completed** God Card resolution in this round. If it is a non-Prometheus God, execute that effect with the Prometheus controller and fresh legal choices.

```ts
async function resolvePrometheus(ctx: GodContext) {
  const previous = state.godResolutionHistory.at(-1);

  if (!previous || previous.god === "prometheus") {
    return finishGodWithNoEffect(ctx, { recordAs: "prometheus" });
  }

  await executeGodEffect(previous.god, {
    controllerId: ctx.controllerId,
    actualGod: "prometheus",
    physicalCardId: null,
    canKeepPhysicalCard: false,
    recordHistory: false,
  });

  finishGod(ctx, { recordAs: "prometheus", copiedGod: previous.god });
}
```

Rules and edge cases:

- Prometheus cannot copy another Prometheus. If the immediately previous completed God was Prometheus, it has no effect; do not skip backward to an earlier God.
- A God currently below Prometheus on the resolution stack is not yet completed and cannot be copied. For example, Prometheus revealed during Ares cannot copy that enclosing Ares.
- The copied effect does not require or move the old physical God Card.
- The Prometheus controller makes every new choice and all targets are revalidated against current state.
- Copying Zeus, Demeter, or Nike creates a persistent effect token associated with Prometheus; the Prometheus physical card itself is discarded.
- Copying Zeus has no effect if the controller already has Zeus protection.
- Copying Hephaestus gives the Prometheus controller the fallback `+4` if no discarded Modifier exists.
- Copying Athena privately reveals cards only to the Prometheus controller.
- Copying Aphrodite reveals a new card; it does not reuse Aphrodite's old reveal.
- Copied execution is not separately appended as the copied God in history. When the entire operation completes, the latest history entry is Prometheus. Therefore a following Prometheus cannot chain-copy it.
- If no God has completed earlier in the round, discard Prometheus without effect.

## 7. Revised scoring

For a non-busted player:

1. Sum all Number Card instances.
2. Add the Demeter bonus: current lowest number value once per Demeter blessing.
3. Apply `x2` to that effective number total.
4. Add all `+N` Modifier instances.
5. Add the normal `+15` if the player achieved Favour of Olympus.
6. Add `+10` per Nike effect if the player achieved Favour of Olympus.

```ts
function calculateRoundScore(player: PlayerState): number {
  if (player.roundStatus === "busted") return 0;

  const baseNumbers = sum(player.numberCards.map(card => card.value));
  const effectiveNumbers = baseNumbers + demeterBonus(player);
  const hasX2 = player.modifierCards.some(card => card.operation === "multiply");
  const additive = sum(
    player.modifierCards
      .filter(card => card.operation === "add")
      .map(card => card.value)
  );

  return effectiveNumbers * (hasX2 ? 2 : 1)
    + additive
    + (hasFavourOfOlympus(player.id) ? 15 : 0)
    + nikeBonus(player.id);
}
```

Example: numbers `2, 5, 8`, Demeter, `x2`, and `+4` score `((2 + 5 + 8 + 2) × 2) + 4 = 38`.

## 8. Gameplay loop changes

```text
player chooses HIT
  -> reveal one physical card
  -> Number: receive it; resolve Zeus/duplicate; check Favour of Olympus
  -> Modifier: receive it
  -> God: controller resolves the God completely
       -> request and validate choices
       -> apply atomic changes
       -> fully resolve nested Gods and forced draws
       -> record completed God in round history
  -> if Favour of Olympus was requested, end the round
  -> else if no active players remain, end the round
  -> else advance to next active player
```

Initial deal uses the same resolver. If a God appears, pause dealing until its entire resolution stack completes. If it causes a player to stay or bust before that player's scheduled initial card, skip that inactive player. If it causes Favour of Olympus, stop the initial deal and score immediately.

## 9. Physical card lifecycle

- Directly drawn Zeus, Demeter, and Nike may remain physically in front of the effect owner as reminders.
- All other resolved God Cards enter discard after their full effect completes.
- A persistent God revealed by Aphrodite uses a token and its physical card enters discard as required by Aphrodite.
- A persistent God copied by Prometheus uses a token; Prometheus enters discard after resolution.
- When direct Zeus triggers, its physical card and the incoming duplicate enter discard.
- At round cleanup, move retained Zeus, Demeter, and Nike cards to discard and remove all persistent God effect tokens.
- Destroy Aphrodite-generated number/modifier instances at cleanup; they are not physical cards and never enter the draw or discard pile.
- Physical cards returned by Hades or Hephaestus leave discard and return to normal in-play lifecycle.
- Cards in `resolvingCards` or any resolution frame are never eligible for mid-effect reshuffling or discard selection.

## 10. Deterministic ordering rules

These rules prevent client timing from changing outcomes:

1. Commands and choices are serialized by server revision.
2. Nested God effects resolve depth-first: finish the newly revealed God before resuming its parent effect.
3. Ares draws resolve one at a time, each including its complete nested resolution.
4. Multi-player number changes apply incoming cards in stable target-seat order for Zeus consumption, then check Favour of Olympus for all affected players together.
5. Hermes removes both outgoing cards, applies both incoming cards, resolves both duplicates, recalculates Demeter, then checks Favour of Olympus.
6. Aphrodite resolves both target outcomes before checking Favour of Olympus.
7. `godResolutionHistory` is appended on completion, not reveal. Nested Gods therefore complete before their enclosing God.
8. Round-end checks run after the current atomic effect, never halfway through it.

## 11. No-legal-target behavior

A God Card is never allowed to deadlock the game.

- Ares/Dyonisus: the controller is active when normally drawn, so at least one target exists. If state changed unexpectedly before choice submission, recompute targets; if none remain, resolve with no effect.
- Athena: reorder up to the available number of drawable cards; zero cards means no effect.
- Hades: no discarded Number Card means no effect.
- Hermes: fewer than two active players with Number Cards means no effect.
- Artemis: no Number Card owned by an active player means no effect.
- Aphrodite: fewer than two active players means no reveal and no effect.
- Hephaestus: no discarded Modifier always creates the fallback `+4`.
- Demeter: no active player with a Number Card means no effect.
- Zeus/Nike: apply to the controller; a duplicate Zeus protection has no effect.
- Prometheus: no previous completed non-Prometheus God means no effect.

Every no-effect God still counts as a completed God resolution for Prometheus history, except a copied sub-effect executed inside Prometheus, which is deliberately not a separate history record.

## 12. Required tests

### Deck and state

- Deck contains 97 unique physical card IDs: 79 numbers, 6 modifiers, and 12 Gods.
- Generated Aphrodite and fallback instances never enter the physical deck.
- `favourOfOlympusPlayerIds` supports zero, one, or multiple achievers.

### Zeus

- First Zeus persists; second Zeus has no effect.
- Duplicate consumes Zeus and the incoming duplicate without busting.
- A later duplicate after Zeus is spent busts.
- Zeus does not prevent Dyonisus.
- Copied/revealed Zeus uses a token and behaves identically.

### Ares

- Exactly three cards resolve when the target remains active and nobody gets Favour of Olympus.
- Modifier and God Cards each consume one forced draw.
- A God revealed by Ares resolves fully before the next forced draw.
- A Zeus-protected duplicate does not stop remaining forced draws.
- An unprotected duplicate stops immediately.
- A nested God causing the forced target to bust or stay stops Ares.
- A nested God affecting someone else allows Ares to continue.
- Nested Ares resolves depth-first, then parent Ares resumes correctly.
- Favour of Olympus during any nested resolution stops all remaining forced draws.

### Dyonisus and Athena

- Dyonisus can force a zero-card player to stay for zero.
- Forced player is skipped for all later turns and active-target choices.
- Athena's card identities are sent only to its controller.
- Athena accepts only an exact permutation of the peeked IDs.
- Athena handles draw-pile sizes 0, 1, 2, and 3+.

### Hades, Hermes, and Artemis

- Hades can select only physical Number Cards currently in discard.
- Hades duplicate follows Zeus/bust rules and can create Favour of Olympus.
- Hermes requires two distinct active players with numbers.
- Hermes exchange is atomic and can bust neither, one, or both players.
- Zeus discards the incoming exchanged card without restoring the outgoing card.
- Hermes recalculates Demeter after both sides resolve.
- Artemis sends physical cards to discard but destroys generated cards.
- Artemis recalculates or dormants Demeter.

### Aphrodite

- Requires two distinct active targets and reveals nothing if fewer than two exist.
- Number creates two temporary instances and discards the physical card.
- Both duplicates resolve before any Favour of Olympus check.
- Both players can achieve Favour of Olympus and both receive normal/Nike bonuses.
- Modifier creates two effects; `x2` does not compound beyond x2 for one player.
- Revealed God resolves once under Aphrodite controller.
- Revealed persistent God uses a token while its physical card is discarded.
- Nested Aphrodite and Ares resolve without corrupting the resolution stack.

### Hephaestus, Demeter, and Nike

- Hephaestus must use a discarded Modifier when one exists.
- With none, controller receives generated `+4`.
- Copied Hephaestus fallback goes to Prometheus controller.
- Demeter tracks the current lowest card after adds, removals, and exchanges.
- Demeter scores zero with no numbers and reattaches after a later number.
- Multiple Demeters add one lowest-card value each.
- `x2` doubles the Demeter-adjusted number total.
- Nike gives +10 only on Favour of Olympus and is not doubled.
- Multiple Nike effects stack additively.

### Prometheus and history

- No prior God means no copied effect.
- Previous Prometheus means no copied effect and does not search farther back.
- Prometheus uses new legal targets and current discard/deck state.
- Prometheus inside an unresolved Ares cannot copy that Ares.
- Copying every other God produces the same effect with Prometheus as controller.
- Copied effect does not create a separate history entry.
- After completion, Prometheus is the most recent history entry.

### Round-end and cleanup

- Atomic multi-player effects finish before round termination.
- Once Favour of Olympus is requested, no further Ares draw or initial-deal card starts.
- All simultaneous Favour of Olympus achievers receive `+15` and their own Nike bonuses.
- No active players ends the round only after the current God effect finishes.
- Retained physical Gods enter discard at cleanup; generated tokens/instances are destroyed.
