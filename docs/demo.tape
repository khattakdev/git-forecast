# Records docs/demo.gif with VHS (https://github.com/charmbracelet/vhs).
# Run from the repo root: npm run demo   (needs: brew install vhs)
# Uses the conflict-step-2 fixture, so the result is the same everywhere.

Output docs/demo.gif

Set Shell "bash"
Set FontSize 18
Set Width 1180
Set Height 680
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms

Hide
Type "mkdir -p .demo-bin && ln -sf \"$PWD/packages/cli/dist/cli.js\" .demo-bin/git-forecast && export PATH=\"$PWD/.demo-bin:$PATH\" && rm -rf /tmp/gf-demo && node fixtures/build.ts --check --out /tmp/gf-demo > /dev/null && cd /tmp/gf-demo/conflict-step-2/work && clear"
Enter
Sleep 6s
Show

Type "git forecast"
Sleep 400ms
Enter
Sleep 4s

Type "git forecast sync"
Sleep 400ms
Enter
Sleep 5s

Type "q"
Sleep 1500ms
