#!/usr/bin/env bash
#
# Публикация репозитория на GitHub.
#
# Создаёт репозиторий через API и заливает в него ветку main.
# Токен НЕ сохраняется на диск: читается из переменной окружения
# GITHUB_TOKEN и живёт только на время запуска.
#
# Использование:
#   GITHUB_TOKEN=ghp_xxx ./scripts/push-to-github.sh [имя-репозитория]
#
# По умолчанию имя: alice-ai-itd-event
#
# Что нужно токену:
#   • классический токен с галочкой «repo», ИЛИ
#   • fine-grained токен с правами: Contents = Read and write,
#     Administration = Read and write (если репозитория ещё нет).
#
set -euo pipefail

REPO_NAME="${1:-alice-ai-itd-event}"
TOKEN="${GITHUB_TOKEN:-}"

if [ -z "$TOKEN" ]; then
    echo "Ошибка: не задан GITHUB_TOKEN." >&2
    echo "Запуск: GITHUB_TOKEN=ghp_xxx $0 [имя-репозитория]" >&2
    exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

API="https://api.github.com"
AUTH=(-H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json")

api() {  # api МЕТОД URL [данные] -> печатает тело ответа, код возвращает через глобальную API_CODE
    local method="$1" url="$2" data="${3:-}"
    if [ -n "$data" ]; then
        API_CODE="$(curl -sS -o /tmp/gh-out.json -w '%{http_code}' -X "$method" "${AUTH[@]}" "$url" -d "$data")"
    else
        API_CODE="$(curl -sS -o /tmp/gh-out.json -w '%{http_code}' -X "$method" "${AUTH[@]}" "$url")"
    fi
}

echo "→ проверяю токен…"
api GET "$API/user"
if [ "$API_CODE" != "200" ]; then
    echo "  токен не принят (HTTP $API_CODE)." >&2
    python3 - <<'PY' >&2 || true
import json
try:
    print("  ответ GitHub:", json.load(open('/tmp/gh-out.json')).get('message', ''))
except Exception:
    pass
PY
    echo "  проверь срок действия и права токена (нужно право на репозитории)." >&2
    rm -f /tmp/gh-out.json
    exit 1
fi
LOGIN="$(python3 -c 'import json; print(json.load(open("/tmp/gh-out.json"))["login"])')"
echo "  пользователь: $LOGIN"

echo "→ создаю репозиторий $LOGIN/$REPO_NAME…"
api POST "$API/user/repos" \
    "{\"name\":\"$REPO_NAME\",\"description\":\"Ивент «Алиса AI × ИТД»: собранный и разобранный HTML (задания, мелки, общая доска)\",\"private\":false}"
case "$API_CODE" in
    201) echo "  создан" ;;
    422) echo "  уже существует — использую его" ;;
    403|404) echo "  не хватает прав создать репозиторий (HTTP $API_CODE)." >&2
             echo "  вариант: создай репозиторий вручную и запусти скрипт снова — он просто зальёт ветку." >&2
             rm -f /tmp/gh-out.json; exit 1 ;;
    *)   echo "  не удалось создать (HTTP $API_CODE)." >&2
         python3 -c 'import json; print("  ответ:", json.load(open("/tmp/gh-out.json")).get("message",""))' >&2 || true
         rm -f /tmp/gh-out.json; exit 1 ;;
esac
rm -f /tmp/gh-out.json

echo "→ заливаю ветку main…"
# URL с токеном подставляется только на время команды и не попадает в .git/config
git -c credential.helper= push -q "https://x-access-token:$TOKEN@github.com/$LOGIN/$REPO_NAME.git" main:main

echo
echo "Готово: https://github.com/$LOGIN/$REPO_NAME"
echo
echo "Не забудь отозвать токен: https://github.com/settings/tokens"
