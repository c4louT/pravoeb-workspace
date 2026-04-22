#!/bin/bash

# ============================================================
# Установка агента Правоеб на новом устройстве
# Использование: bash setup_new_device.sh
# ============================================================

REPO="git@github.com:c4louT/pravoeb-workspace.git"
WORKSPACE="$HOME/.openclaw/workspace"

echo "🦞 Устанавливаю агента Правоеб на новом устройстве..."

# Проверяем зависимости
command -v git >/dev/null || { echo "❌ Установи git: brew install git"; exit 1; }
command -v python3 >/dev/null || { echo "❌ Установи Python 3"; exit 1; }

# Клонируем workspace
if [ -d "$WORKSPACE" ]; then
  echo "⏭️  Workspace уже существует, делаем git pull..."
  git -C "$WORKSPACE" pull
else
  echo "📦 Клонирую workspace из GitHub..."
  mkdir -p "$HOME/.openclaw"
  git clone "$REPO" "$WORKSPACE"
fi

# Создаём локальные папки (не в git)
mkdir -p "$WORKSPACE/memory/tema"
mkdir -p "$WORKSPACE/memory/senya"
mkdir -p "$WORKSPACE/memory/vova"
mkdir -p "$WORKSPACE/memory/shared"
mkdir -p "$WORKSPACE/state"

echo "✅ Локальные папки созданы (memory/, state/)"

# Устанавливаем Python-зависимости
if [ -f "$WORKSPACE/tools/requirements.txt" ]; then
  echo "📦 Устанавливаю Python зависимости..."
  python3 -m pip install -r "$WORKSPACE/tools/requirements.txt" --break-system-packages 2>/dev/null || true
fi

echo ""
echo "🎉 Готово! Агент установлен в $WORKSPACE"
echo ""
echo "Следующий шаг: запусти OpenClaw"
echo "  openclaw onboard"
