#!/usr/bin/env sh
# Тот же запуск для macOS и Linux: ставит зависимости при первом старте.
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не найден. Установите его с https://nodejs.org и запустите скрипт снова."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Ставим зависимости, это займёт минуту..."
  npm install
fi

exec node server/index.js
