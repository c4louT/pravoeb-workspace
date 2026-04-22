# Legal Toolkit — Справочник для Правоеба

_Это не просто список ссылок. Это готовые шаблоны запросов и URL для `web_fetch`,
чтобы быстро доставать правовую информацию из открытых источников._

---

## 🛠 Быстрые команды (зови эти скрипты через `exec`)

### Парсер договоров (PDF / DOCX / TXT)

```bash
/Users/calout/.openclaw/workspace/tools/.venv/bin/python \
  /Users/calout/.openclaw/workspace/tools/extract.py <путь-к-файлу>
```

- Поддерживает `.pdf`, `.docx`, `.txt`, `.md`, `.rtf`.
- Извлекает текст параграфов и таблиц (для DOCX).
- Опция `--max-chars N` — обрезать длинный файл.

### Проверка контрагента (ИНН/ОГРН)

```bash
/Users/calout/.openclaw/workspace/tools/.venv/bin/python \
  /Users/calout/.openclaw/workspace/tools/check_egrul.py <ИНН-или-ОГРН>
```

Выдаёт URL для проверки. Реальные данные тянем через `web_fetch` (см. ниже).

---

## 🌐 Открытые правовые источники — prompt-шаблоны

### 1. Актуальная редакция закона / кодекса

**Источник:** `pravo.gov.ru` — официальное опубликование, всегда последняя редакция.

```
Запрос пользователя: «покажи актуальную ст. 1295 ГК РФ»

План:
  1. web_fetch "http://pravo.gov.ru/" + навигация
  2. Или web_fetch "https://www.consultant.ru/document/cons_doc_LAW_64629/"
     (ч. 4 ГК на Консультанте — бесплатная часть)
  3. Извлечь текст статьи, дать с датой редакции.
```

**Удобные ссылки на кодексы (Консультант, бесплатно):**

- **ГК РФ ч. 1** — `https://www.consultant.ru/document/cons_doc_LAW_5142/`
- **ГК РФ ч. 2** — `https://www.consultant.ru/document/cons_doc_LAW_9027/`
- **ГК РФ ч. 4** (интеллектуалка) — `https://www.consultant.ru/document/cons_doc_LAW_64629/`
- **ТК РФ** — `https://www.consultant.ru/document/cons_doc_LAW_34683/`
- **ГПК РФ** — `https://www.consultant.ru/document/cons_doc_LAW_39570/`
- **АПК РФ** — `https://www.consultant.ru/document/cons_doc_LAW_37800/`
- **КоАП** — `https://www.consultant.ru/document/cons_doc_LAW_34661/`

### 2. Проверка юрлица / ИП

**Источник:** `egrul.nalog.ru` — ФНС, выписка из ЕГРЮЛ/ЕГРИП.

Прямого JSON API нет — работаем через веб. Алгоритм:

```
1. web_fetch "https://egrul.nalog.ru/index.html?query=<ИНН>"
   — получаем страницу со списком найденных юрлиц
2. Если нашёлся — смотрим карточку: ОГРН, юр.адрес, директор, учредители, статус
3. Если «ликвидировано» или «исключено» — сразу красный флаг
```

**Альтернатива — free API:**

- `https://api.ofdata.ru/v2/company?key=PUBLIC_KEY&inn=<ИНН>` — требует регистрации
- `https://www.rusprofile.ru/search?query=<ИНН>` — можно парсить как HTML

### 3. Проверка исков / арбитраж

**Источник:** `kad.arbitr.ru` — картотека арбитражных дел.

```
URL поиска: https://kad.arbitr.ru/Kad/Card?text=<ИНН-или-название>
```

Делает POST-запрос; часто удобнее искать через `sudact.ru` или `casebook.ru`.

**Что смотреть:** роль (истец/ответчик), сумма иска, исход. Много исков в роли ответчика = красный флаг.

### 4. Долги ФССП

**Источник:** `fssp.gov.ru/iss/ip`

```
Для юрлиц: https://fssp.gov.ru/iss/ip_search
Для физлиц: https://fssp.gov.ru/iss/ip_search (форма)
```

Есть капча — через web_fetch может не пройти напрямую. Как альтернатива — `https://api.fssp.gov.ru` (тоже с ограничениями).

### 5. Проверка банкротств

**Источник:** `fedresurs.ru` (ЕФРСБ) и `bankrot.fedresurs.ru`.

```
https://bankrot.fedresurs.ru/bankrupts?searchString=<ИНН>&typesOfPersons=-1
```

### 6. Судебная практика ВС РФ

**Источник:** `vsrf.ru`, `sudact.ru`, `sudrf.ru`.

```
- https://vsrf.ru/documents/all/ — все документы ВС
- https://www.sudact.ru/regular/doc/?regular-txt=<запрос> — полнотекст
- Поиск по реквизитам: https://vsrf.ru/stor_pdf.php?id=<ID>
```

**Ключевой документ по интеллектуалке:**
Постановление Пленума ВС РФ от 23.04.2019 № 10
`https://www.vsrf.ru/documents/own/27773/` (или через Консультант)

### 7. Быстрые ответы по ГК/ТК — бесплатный Консультант

Сайт `consultant.ru` имеет огромное количество бесплатного:
- Все кодексы с гиперссылками
- Комментарии к избранным статьям
- Часть обзоров ВС

Шаблон URL для поиска:
`https://www.consultant.ru/search/base/?q=<запрос>&brand=1`

---

## 📋 Типовые комбо-запросы

### «Проверь контрагента <ИНН>»

1. `check_egrul.py <ИНН>` → получить URL
2. `web_fetch` на egrul.nalog.ru → выписка
3. `web_fetch` на `rusprofile.ru/id/<ИНН>` (если нашёлся OGRN) → доп. данные
4. `web_fetch` на `bankrot.fedresurs.ru` → банкротство
5. `web_fetch` на `kad.arbitr.ru` → иски
6. Суммировать: статус / директор / адрес / долги / иски / банкротство / вердикт

### «Покажи ст. <N> ГК РФ»

1. Выбрать правильный кодекс (ч. 1 / 2 / 4) по номеру
2. `web_fetch` на Консультант → найти статью
3. Процитировать + добавить своё толкование + типовые споры

### «Найди позицию ВС по <вопрос>»

1. `web_fetch` на `vsrf.ru` с поиском
2. `web_fetch` на `sudact.ru/search/?q=...`
3. Отобрать 3-5 самых релевантных
4. Дать выжимку + свою оценку применимости

---

## 🚧 Что пока не покрыто toolkit'ом (для будущей работы)

- [ ] Автоматическая проверка ФССП с капчей → нужен selenium / anti-captcha
- [ ] Подписка Caselook → после оформления: сохранение cookies
- [ ] Генерация DOCX на выходе → нужен `pandoc` (ставится в фоне через brew)
- [ ] OCR для сканов договоров (PDF без текстового слоя) → `tesseract`

---

_Правоеб, читай этот файл перед тем как лезть в открытые источники — там готовые URL-шаблоны._
