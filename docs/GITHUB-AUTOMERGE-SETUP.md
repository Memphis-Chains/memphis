# GitHub Auto-merge setup (no manual merge)

Cel: po spełnieniu warunków PR ma się scalić automatycznie, bez ręcznego klikania Merge.

## 1) Co już jest w repo

Dodany workflow:
- `.github/workflows/automerge.yml`

Działanie:
- jeśli PR ma label `automerge` i nie jest draftem,
- workflow włącza GitHub Auto-merge (squash),
- PR scali się sam po przejściu wymaganych checków.

## 2) One-time ustawienia w GitHub (UI)

Repo → **Settings** → **General**
- ✅ Allow auto-merge
- ✅ Allow squash merging
- (opcjonalnie) ❌ wyłącz merge commit/rebase, jeśli chcesz jeden standard

Repo → **Settings** → **Branches** → Branch protection / Ruleset dla `main`
- ✅ Require a pull request before merging
- ✅ Require status checks to pass before merging
  - dodaj check: `quality-gate`
- ✅ Dismiss stale pull request approvals when new commits are pushed (opcjonalnie)
- ✅ Require conversation resolution before merging (opcjonalnie)

## 3) Jak używać (operacyjnie)

1. Tworzysz PR
2. Dodajesz label `automerge`
3. Workflow automatycznie włączy auto-merge
4. Gdy `quality-gate` będzie zielony → PR scalony sam

## 4) Bezpieczeństwo

- Auto-merge jest świadomie „opt-in” przez label `automerge`.
- Bez labela PR NIE scali się automatycznie.
- Chroni to przed przypadkowym merge przy czerwonym CI lub niegotowym PR.
