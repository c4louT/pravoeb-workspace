#!/usr/bin/env python3
"""Phase 5b: select 20 key templates, copy to repo, generate templates_index.json entries.

Output:
- /home/ubuntu/repos/pravoeb-workspace/contracts/templates/<file>.md (new files)
- new entries appended to templates_index.json (kept as JSON dict here, merged manually later)
"""
import json, re, shutil, unicodedata
from pathlib import Path

SRC = Path("/tmp/phase5b/md")
REPO = Path("/home/ubuntu/repos/pravoeb-workspace")
OUT_TEMPLATES = REPO / "contracts" / "templates"
OUT_INDEX = REPO / "contracts" / "templates_index.json"

# Selection: (id, src_filename_stem, label, category, role_group, tax_form, filename_template)
SELECTION = [
    # === Replace/upgrade existing actor templates ===
    ("actor_school", "Договор_на_участие_в_съемках_ФЛАктер",
     "Актёр (взрослый ФЛ, версия Киношколы)", "договор", "Актёрский цех", "ФЛ",
     "Договор_актер_{lastName}_{yearMonth}"),
    ("actor_minor_under14_school", "Договор_на_участие_в_съемках_ФЛ_Актер_до_14_лет",
     "Актёр-ребёнок до 14 лет (Киношкола)", "договор", "Актёрский цех", "ФЛ",
     "Договор_актер_до14_{lastName}_{yearMonth}"),
    ("actor_minor_14_17_school", "Договор_на_участие_в_съемках_ФЛ_Актер_от_14_до_17_лет",
     "Актёр-подросток 14-17 лет (Киношкола)", "договор", "Актёрский цех", "ФЛ",
     "Договор_актер_14_17_{lastName}_{yearMonth}"),

    # === Director group ===
    ("director_main_ip", "Договор_оказания_услуг_с_режиссером-_постановщиком_ИП",
     "Режиссёр-постановщик (ИП)", "договор", "Режиссёрский цех", "ИП",
     "Договор_режиссер_ИП_{lastName}_{yearMonth}"),
    ("director_main_fl", "Договор_оказания_услуг_с_режиссером-постановщиком_ФЛ_рамочный",
     "Режиссёр-постановщик (ФЛ, рамочный)", "договор", "Режиссёрский цех", "ФЛ",
     "Договор_режиссер_ФЛ_{lastName}_{yearMonth}"),
    ("director_main_sz", "Договор_оказания_услуг_с_режиссером-постановщикомсамозанятый",
     "Режиссёр-постановщик (Самозанятый)", "договор", "Режиссёрский цех", "СЗ",
     "Договор_режиссер_СЗ_{lastName}_{yearMonth}"),
    ("second_director_ip", "Договор_оказания_услуг_-_второй_режиссер_ИП",
     "Второй режиссёр (ИП)", "договор", "Режиссёрский цех", "ИП",
     "Договор_2режиссер_ИП_{lastName}_{yearMonth}"),
    ("asst_director_ip_fl", "Договор_оказания_услуг_-_ассистент_режиссера_ФЛ_или_ИП",
     "Ассистент режиссёра (ФЛ или ИП)", "договор", "Режиссёрский цех", "ФЛ/ИП",
     "Договор_ассрежиссер_{lastName}_{yearMonth}"),
    ("editor_ip", "Договор_оказания_услуг_-_режиссер_монтажа_фильм_этюд_ИП",
     "Режиссёр монтажа (ИП)", "договор", "Режиссёрский цех", "ИП",
     "Договор_монтажер_ИП_{lastName}_{yearMonth}"),

    # === Producer ===
    ("exec_producer_ip", "Договор_оказания_услуг_-_исполнительный_продюсер_ИП",
     "Исполнительный продюсер (ИП)", "договор", "Продюсерская группа", "ИП",
     "Договор_испродюсер_ИП_{lastName}_{yearMonth}"),

    # === Camera/operator group ===
    ("dop_ip", "Договор_на_услуги_оператора-постановщика_ИП",
     "Оператор-постановщик (ИП)", "договор", "Операторский цех", "ИП",
     "Договор_оператор_ИП_{lastName}_{yearMonth}"),
    ("backstage_op", "Договор_на_услуги_оператора_бэкстейджа_не_рамочный",
     "Оператор бэкстейджа", "договор", "Операторский цех", "?",
     "Договор_бэкстейдж_{lastName}_{yearMonth}"),
    ("steadicam_op_ip", "Договор_оказания_услуг_-_оператор_стедикама_ИП",
     "Оператор стедикама (ИП)", "договор", "Операторский цех", "ИП",
     "Договор_стедикам_ИП_{lastName}_{yearMonth}"),

    # === Sound/music ===
    ("sound_engineer_ip", "Договор_оказания_услуг_-_звукорежиссер_ИП",
     "Звукорежиссёр (ИП)", "договор", "Звукоцех", "ИП",
     "Договор_звукреж_ИП_{lastName}_{yearMonth}"),
    ("composer_sz", "Договор_оказания_услуг_-_композитор_самозанятый",
     "Композитор (Самозанятый)", "договор", "Звукоцех", "СЗ",
     "Договор_композитор_СЗ_{lastName}_{yearMonth}"),
    ("voiceover_sz", "Договор_выполнения_работ_по_закадровому_озвучиванию_самозанятый",
     "Закадровое озвучивание (Самозанятый)", "договор", "Звукоцех", "СЗ",
     "Договор_закадр_СЗ_{lastName}_{yearMonth}"),

    # === Art department ===
    ("production_designer_ip", "Договор_оказания_услуг_-_художник-постановщик_ИП",
     "Художник-постановщик (ИП)", "договор", "Художественный цех", "ИП",
     "Договор_худпост_ИП_{lastName}_{yearMonth}"),
    ("costume_designer_ip", "Договор_оказания_услуг_-_Художник_по_костюмам_ИП",
     "Художник по костюмам (ИП)", "договор", "Художественный цех", "ИП",
     "Договор_худкост_ИП_{lastName}_{yearMonth}"),
    ("makeup_artist_ip", "Договор_оказания_услуг_-_художник_по_гриму_ИП",
     "Художник по гриму (ИП)", "договор", "Художественный цех", "ИП",
     "Договор_худгрим_ИП_{lastName}_{yearMonth}"),

    # === Stunt / choreography ===
    ("choreographer_ip", "Договор_оказания_услуг_-_хореограф_ИП",
     "Хореограф (ИП)", "договор", "Постановочная группа", "ИП",
     "Договор_хореограф_ИП_{lastName}_{yearMonth}"),

    # === Rights ===
    ("screenplay_alienation_fl", "Договор_отчуждения_прав_на_сценарий_ФЛ",
     "Отчуждение прав на сценарий (ФЛ)", "договор", "Авторские права", "ФЛ",
     "Договор_отчуждение_сценарий_{lastName}_{yearMonth}"),
    ("license_avp_ip", "Лицензионный_договор_на_использование_произведения_в_составе_АВП_с_ИП",
     "Лицензионный договор на произведение в АВП (ИП)", "договор", "Авторские права", "ИП",
     "Договор_лицензия_АВП_{lastName}_{yearMonth}"),
    ("image_consent_extra", "Согласие_на_использование_изображения_передача_прав_на_рид_массовка",
     "Согласие на изображение + передача прав на РИД (массовка)", "согласие", "Согласия", "ФЛ",
     "Согласие_изображение_{lastName}_{yearMonth}"),
]

# Common field schema templates (re-usable across roles)
FIELD_DEFS = {
    "[Номер договора]":         {"key": "[Номер договора]", "label": "Номер договора", "type": "text", "required": True, "placeholder": "напр. КШ-2026-001"},
    "[День]":                   {"key": "[День]", "label": "День заключения (число)", "type": "text", "required": True, "placeholder": "26"},
    "[Месяц]":                  {"key": "[Месяц]", "label": "Месяц заключения", "type": "text", "required": True, "placeholder": "апреля"},
    "[Год]":                    {"key": "[Год]", "label": "Год заключения (последние 2 цифры)", "type": "text", "required": True, "placeholder": "26"},
    "[Дата заключения]":        {"key": "[Дата заключения]", "label": "Дата заключения", "type": "date", "required": True},
    "[Представитель Изготовителя]": {"key": "[Представитель Изготовителя]", "label": "Представитель Заказчика (Изготовителя)", "type": "text", "required": True, "autofill": "school.rep"},
    "[Основание полномочий]":   {"key": "[Основание полномочий]", "label": "Основание полномочий", "type": "text", "required": True, "default": "Устава"},
    "[ФИО контрагента]":        {"key": "[ФИО контрагента]", "label": "ФИО контрагента", "type": "text", "autofill": "contact.name", "required": True},
    "[ОГРНИП]":                 {"key": "[ОГРНИП]", "label": "ОГРНИП", "type": "text"},
    "[Серия ОГРНИП]":           {"key": "[Серия ОГРНИП]", "label": "Серия ОГРНИП", "type": "text"},
    "[Паспорт серия]":          {"key": "[Паспорт серия]", "label": "Паспорт: серия", "type": "text"},
    "[Паспорт номер]":          {"key": "[Паспорт номер]", "label": "Паспорт: номер", "type": "text"},
    "[Кем выдан]":              {"key": "[Кем выдан]", "label": "Паспорт: кем выдан", "type": "text"},
    "[Кем выдан паспорт]":      {"key": "[Кем выдан паспорт]", "label": "Паспорт: кем выдан", "type": "text"},
    "[Дата выдачи паспорта]":   {"key": "[Дата выдачи паспорта]", "label": "Паспорт: дата выдачи", "type": "date"},
    "[Адрес регистрации]":      {"key": "[Адрес регистрации]", "label": "Адрес регистрации", "type": "text"},
    "[Дата рождения]":          {"key": "[Дата рождения]", "label": "Дата рождения", "type": "date"},
    "[ИНН контрагента]":        {"key": "[ИНН контрагента]", "label": "ИНН контрагента", "type": "text"},
    "[СНИЛС]":                  {"key": "[СНИЛС]", "label": "СНИЛС", "type": "text"},
    "[КПП]":                    {"key": "[КПП]", "label": "КПП", "type": "text"},
    "[Расчётный счёт]":         {"key": "[Расчётный счёт]", "label": "Расчётный счёт", "type": "text"},
    "[Банк]":                   {"key": "[Банк]", "label": "Банк", "type": "text"},
    "[Корсчёт]":                {"key": "[Корсчёт]", "label": "Корсчёт", "type": "text"},
    "[БИК]":                    {"key": "[БИК]", "label": "БИК", "type": "text"},
    "[Телефон]":                {"key": "[Телефон]", "label": "Телефон контрагента", "type": "text", "autofill": "contact.phone"},
    "[Email]":                  {"key": "[Email]", "label": "Email контрагента", "type": "text", "autofill": "contact.email"},
    "[Email Изготовителя]":     {"key": "[Email Изготовителя]", "label": "Email Заказчика", "type": "text", "default": "info@bondarchuk.com"},
    "[Название фильма]":        {"key": "[Название фильма]", "label": "Название фильма", "type": "text", "autofill": "project.name", "required": True},
    "[Режиссёр-постановщик]":   {"key": "[Режиссёр-постановщик]", "label": "Режиссёр-постановщик", "type": "text"},
    "[Автор сценария]":         {"key": "[Автор сценария]", "label": "Автор сценария", "type": "text"},
    "[Дата начала]":            {"key": "[Дата начала]", "label": "Дата начала работ", "type": "date", "autofill": "project.start_date"},
    "[Дата окончания]":         {"key": "[Дата окончания]", "label": "Дата окончания работ", "type": "date", "autofill": "project.end_date"},
    "[Сумма цифрами]":          {"key": "[Сумма цифрами]", "label": "Сумма (цифрами)", "type": "text", "required": True, "placeholder": "100 000"},
    "[Сумма прописью]":         {"key": "[Сумма прописью]", "label": "Сумма (прописью)", "type": "text", "required": True, "placeholder": "Сто тысяч"},
    "[Срок цифрой]":            {"key": "[Срок цифрой]", "label": "Срок (число дней)", "type": "text"},
    "[Срок прописью]":          {"key": "[Срок прописью]", "label": "Срок (прописью)", "type": "text"},
    "[Подпись]":                None,  # auto-rendered as line in DOCX
    "[ФИО]":                    None,  # filled at sign-time
}

def slug(s):
    n = unicodedata.normalize("NFC", s)
    n = re.sub(r"[^\w\-]", "_", n, flags=re.UNICODE)
    n = re.sub(r"_+", "_", n).strip("_")
    return n

def detect_used_placeholders(text):
    """Find every [Tag] in template, return ordered set."""
    found = re.findall(r"\[[А-Яа-яA-Za-z][^\]\[]{0,80}\]", text)
    seen = []
    for f in found:
        if f not in seen and f != "[?]":
            seen.append(f)
    return seen

def build():
    # Load existing index
    existing = json.loads(OUT_INDEX.read_text(encoding="utf-8"))
    # Drop any prior phase 5b additions (re-runnable)
    PHASE5B_IDS = {tid for tid, *_ in SELECTION}
    existing["templates"] = [t for t in existing.get("templates", []) if t["id"] not in PHASE5B_IDS]
    existing_ids = {t["id"] for t in existing.get("templates", [])}

    # Discover defaults block (we'll add school)
    if "defaults" not in existing:
        existing["defaults"] = {}
    existing["defaults"]["school"] = {
        "name": "ООО «Киношкола имени Сергея Фёдоровича Бондарчука»",
        "short_name": "Киношкола",
        "inn": "9701057530",
        "kpp": "770901001",
        "ogrn": "5167746408660",
        "address": "г. Москва",
        "rep": "",
        "rep_basis": "Устава"
    }

    new_entries = []
    field_warnings = []
    for tid, src_stem, label, category, role_group, tax_form, filename_template in SELECTION:
        if tid in existing_ids:
            print(f"SKIP {tid}: already in index")
            continue
        # Find source .md
        src_md = SRC / f"{src_stem}.md"
        if not src_md.exists():
            # Try fuzzy match
            candidates = list(SRC.glob(f"*{src_stem.split('_')[-1]}*"))
            print(f"MISSING {tid}: source .md not found ({src_md.name}), candidates: {[c.name for c in candidates[:3]]}")
            continue
        text = src_md.read_text(encoding="utf-8")
        out_filename = f"{tid}.md"
        # Add header with metadata (matches Phase 5a convention so dgStripHeader removes it)
        content = f"# ШАБЛОН: {label}\n# Файл на выходе: {filename_template}.docx\n# Категория: {category} / {role_group} / {tax_form}\n\n{text}"
        (OUT_TEMPLATES / out_filename).write_text(content, encoding="utf-8")

        # Build field list from detected placeholders
        used = detect_used_placeholders(text)
        fields = []
        for ph in used:
            if ph in FIELD_DEFS:
                fd = FIELD_DEFS[ph]
                if fd is not None:
                    fields.append(fd)
            else:
                # Generic free-text field
                fields.append({
                    "key": ph,
                    "label": ph.strip("[]"),
                    "type": "text",
                })
        # Always include category, role_group, tax_form metadata in entry
        entry = {
            "id": tid,
            "file": out_filename,
            "label": label,
            "category": category,
            "role_group": role_group,
            "tax_form": tax_form,
            "filename_template": filename_template,
            "fields": fields,
        }
        new_entries.append(entry)
        print(f"OK {tid}: {len(fields)} fields, {len(used)} placeholders")

    # Append entries
    existing.setdefault("templates", [])
    existing["templates"].extend(new_entries)

    # Write back
    OUT_INDEX.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nAdded {len(new_entries)} new templates to index ({len(existing['templates'])} total)")

if __name__ == "__main__":
    build()
