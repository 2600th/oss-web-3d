# Flight Control Feedback Fix Design

Date: 2026-08-15
Status: Approved for implementation
Target: `main`

## Goal

Resolve the confirmed browser-keyboard conflict and keep default Assisted flight safely above the stall-warning band during sustained turns without removing intentional energy loss. Preserve Direct mode, manual-throttle Assisted mode, and the existing control-mode semantics.

## Confirmed findings

1. `Ctrl` is the current slow-down/throttle-down binding. The input layer deliberately leaves Ctrl-modified browser shortcuts available, so holding throttle-down while pressing common flight keys can select the page, bookmark it, close the tab, or trigger another browser action.
2. Default Assisted auto-throttle schedules throttle from turn load but has no airspeed feedback. As speed falls, requested load and commanded throttle both fall. A sustained normal-sensitivity maximum turn enters the user-facing stall-warning state after about 27 seconds.
3. Neutral Assisted flight does not lose speed or stall. Energy loss under load is intentional, so removing induced drag globally would solve the wrong problem.
4. Maximum throttle is sufficient to keep the default normal-sensitivity turn just outside the stall-warning band. High sensitivity may also require the Assisted controller to unload the turn near that band.

## Considered approaches

### Recommended: rebind plus Assisted envelope protection

- Replace keyboard `Ctrl` with `X` for slow-down/throttle-down in input handling, briefing copy, README documentation, and regression tests.
- Add airspeed feedback to automatic throttle. Retain the existing load-based schedule at ordinary speed, then smoothly increase throttle toward maximum as airspeed approaches the warning band.
- If maximum throttle alone cannot protect a selected sensitivity profile, smoothly reduce Assisted turn demand near the warning band. Do not abruptly clamp the aircraft or restore lost speed.

This keeps the intended energy-management character, confines protection to the mode that promises assistance, and leaves the physical model shared by Direct mode unchanged.

### Rejected: reduce induced drag globally

This would improve retention in every mode, but it would also alter Direct flight and erase a deliberate part of the flight model.

### Rejected: command maximum throttle throughout every turn

This is simple but would make ordinary shallow turns use reheat, weaken the speed controls, and still does not protect the high-sensitivity envelope indefinitely.

## Detailed behavior

### Keyboard binding

- `X` means slow down in Assisted mode and throttle down in Direct mode.
- `Ctrl` has no flight action.
- `X` must not suppress unrelated browser shortcuts or change text-entry handling.
- Gamepad and touch bindings remain unchanged.

### Assisted speed protection

- Automatic throttle retains its current cruise and turn-load schedule above the protection range.
- Below the protection entry speed, commanded throttle blends progressively toward full power as airspeed falls.
- Near the stall-warning band, Assisted turn demand may blend down only as much as needed to remain outside the warning state under sustained maximum turn input.
- The transition must be continuous; no throttle, bank, or turn-rate step should occur at a threshold.
- Boost remains an explicit maximum-throttle command.
- With auto-throttle disabled, the positional throttle continues to pass through unchanged.
- Direct mode remains completely unchanged apart from the keyboard rebind.

## Regression tests

- Input tests prove `X` drives both semantic slow-down intent and the Direct throttle lever, while `Ctrl` drives neither.
- UI/documentation contract tests prove the advertised keyboard binding is `X`, not `Ctrl`.
- A sustained default Assisted maximum turn must retain visible energy loss yet never enter `flight.stalling`.
- A sustained high-sensitivity Assisted maximum turn must remain finite and outside the stall-warning state.
- Existing tests continue to prove neutral auto-cruise, sensitivity ordering, boost behavior, manual throttle pass-through, frame-rate convergence, and Direct input behavior.

## Verification

- Run each new regression before production edits and confirm it fails for the intended reason.
- Run focused input, UI, and flight-controller tests after implementation.
- Run the full Node test suite, production build, and `git diff --check`.
- Review the final diff and repository status to ensure no unrelated user changes were included.

## Scope boundaries

- No option-menu changes; the user selected only feedback items 1 and 3.
- No global aerodynamic, thrust, stall-warning, sensitivity-profile, touch, or gamepad retuning unless a failing protection test proves a minimal Assisted-only adjustment is necessary.
- No deployment, push, or pull request in this task.
