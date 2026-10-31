# Glimpse design notes

**Subject.** A capture tool that sits over whatever is on screen: games, chats, code. People use it in a two-second burst (grab, mark up, paste) and leave. The UI has to stay out of the picture and feel like a camera, not like a web app.

**Idea: the viewfinder.** The words and shapes come from a camera:
- The selection is framed by viewfinder corner brackets, not a dashed box.
- The focus-confirm yellow marks what is selected or active.
- The recording tally red means "recording" and nothing else.
- Size, time and frame counts read like a camera display, in a condensed face with even-width digits.

## Tokens

| Name | Hex | Role |
| --- | --- | --- |
| Body | `#1C2027` | panels, windows (cool graphite, not black) |
| Body raised | `#262B34` | inputs, hover, segmented tracks |
| Edge | `#343A45` | 1px panel edges |
| Paper | `#ECEEF2` | primary text, icons |
| Fog | `#8C93A1` | secondary text |
| Focus | `#FFD23F` | selection, active tool, primary action (ink text on it) |
| Tally | `#FF4B3E` | recording only |

**Type.**
- Barlow (400/500/600/700) for the interface.
- Barlow Semi Condensed (500–700, tabular numerals) for every readout: dimensions, timecode, frame counts, file size, hotkeys.
- Sentence case everywhere and no all-caps labels. Meta info goes in separate elements, never strings joined with dots.

**Shape.** Radii follow hierarchy:
- 14px on floating panels
- 9px on buttons
- 4px on chips and keycaps
- round only for color swatches and the record button

**Motion.**
- None on show/hide; Windows animations are off.
- Only the response to an action moves: active tool, pressed button, trim handles.

## Where the boldness goes

1. **Overlay:** yellow corner brackets on the selection and a readout tab hung off its top-left corner. Everything else on the overlay is quiet graphite.
2. **Editor:** a filmstrip of real frames under the player, with yellow trim handles. It's the one big visual in that window.
3. **History:** captures grouped by day on a dark light-table, labelled with their capture time.

## Review notes

- I considered near-black with a single acid accent (a default), then kept graphite plus two meaning-bound accents (focus, tally). Overlays sit on arbitrary screenshots, so panels must be dark and neutral.
- I dropped the violet accent from v1. It was a generic default with no tie to cameras.
- I dropped the hint pill per user request, and toolbars appear only after a selection.
