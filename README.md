# Detour: interactive prototype

Clickable version of the Figma "What people actually see" board.

## Run it

From this folder:

```bash
python -m http.server 8123
```

Then open http://localhost:8123. You can also double-click `index.html`; everything is plain HTML/CSS/JS with no build step.

## What you can do

- **Pick a person** (Sara, Lena, Tom, Yusuf, Noor, Max). Each has their own inputs, preferences and phone.
- **Change their inputs** (heart rate, stress, sleep, location, agenda, steps, time & routine…) or add/remove input signals. The model updates live.
- **Watch the Detour model**:
  1. *Predict the craving*: logistic score from every input, plus which kind of craving it is (stress / habit / social / boredom).
  2. *Choose what & when*: ranks every output by personal preference × fit with the craving type × context.
  3. *Learn from every slip*: accepting, dismissing, "try something else" and "I smoked" all shift the person's preferences and baseline.
- **Use the phone**: tap the notification to open the breathing exercise, walk timer, buddy chat, chatbot, healing-body view, or a covert Spotify / YouTube / News distraction.
- **Researcher panel**: switch input and output modules on or off, or publish a new input signal.

## Files

- `index.html`: page layout
- `styles.css`: styling, based on the Figma colours
- `app.js`: personas, input/output modules, the model, and all phone screens
- `icons.js`: inline icon set, so the prototype works offline

To tune a person, edit their entry in `PERSONAS` in `app.js` (`inputs`, `routines`, `prefs`, `bias`).
