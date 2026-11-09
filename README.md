# Mull

Short daily drills for addition, subtraction, multiplication, and division facts. Mull tracks every fact from 0 to 12 and spends your time on the ones that aren't automatic yet.

It's a static site with no build step, dependencies, or account. Progress is saved in your browser.

## Run it

Open `index.html` in a browser.

## How practice works

- Pick an operation or Mixed, a round length, and how quickly an answer must come to count as fast.
- Answers submit as soon as you've typed enough digits. Use the keyboard, or the on-screen keypad on touch devices.
- A wrong or timed-out answer shows the correct one, and you type it before moving on.
- Facts you already know pass on the first fast answer. Others are learned about four at a time and repeat until you've answered them quickly twice.
- Fluent facts come back after 1, 3, 7, and then 21 days. A slow answer or a miss moves a fact back.

| Status | Meaning |
| --- | --- |
| Not yet | Hasn't been practiced |
| Learning | Repeating within rounds |
| Fluent | Fast, and on a review schedule |
| Mastered | Stayed fast through reviews over about 11 days |

## Project layout

- `engine.js`: facts, scheduling, and progress, with no DOM access
- `app.js`: screens, timers, and input
- `style.css`: styles, including dark mode
- `test/engine.test.js`: engine tests

## Test

Requires Node 18 or later.

```bash
node --test
```
