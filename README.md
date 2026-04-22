# Правоеб — Workspace

ИИ-юрист для продюсера кино и ТВ. Работает через OpenClaw в Telegram.

## Структура

- `SOUL.md` — личность и характер агента
- `IDENTITY.md` — имя, специализация, вайб
- `AGENTS.md` — правила работы и протоколы
- `USER.md` — информация о пользователе
- `CONTRACTS.md` — стандарт оформления договоров
- `TEMPLATES_INDEX.md` — навигатор по шаблонам
- `LEGAL_BASE.md` — правовая база (гражданское и трудовое право РФ)
- `CHECKLISTS.md` — чеклисты по этапам производства
- `contracts/templates/` — 10 шаблонов договоров
- `tools/` — скрипты для работы с файлами

## Не в репозитории (локально)

- `memory/` — личная память пользователей (приватно)
- `state/` — рабочее состояние сессий
- `PROJECTS.md` — реестр проектов с личными данными

## Установка на новом устройстве

```bash
git clone git@github.com:c4louT/pravoeb-workspace.git ~/.openclaw/workspace
```

Затем создать локально папки:
```bash
mkdir -p ~/.openclaw/workspace/memory
mkdir -p ~/.openclaw/workspace/state
```
