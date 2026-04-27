#!/usr/bin/env python3
"""Convert extracted .txt contract templates to .md with semantic [Placeholders].

Pipeline:
1. Read each .txt from /tmp/phase5b/text/
2. Apply ordered regex substitutions to replace `___` and contextual blanks with [Tags]
3. Detect tax_form (ИП / ФЛ / СЗ) from filename
4. Output to /tmp/phase5b/md/ with normalized name + frontmatter
"""
import os, re, unicodedata, json
from pathlib import Path
from collections import OrderedDict

SRC = Path("/tmp/phase5b/text")
DST = Path("/tmp/phase5b/md")
DST.mkdir(exist_ok=True, parents=True)

# Patterns to substitute, applied IN ORDER (earlier wins).
# Each entry: (regex, replacement, set_of_field_keys_used)
# Use lookbehind/lookahead to preserve surrounding text.
SUBS = [
    # === Title / number ===
    (r"ДОГОВОР\s*№\s*_+", r"ДОГОВОР № [Номер договора]", {"contract_number"}),
    (r"Договор[ау]?\s*№\s*_+\s+от\s+_+\s*год[ау]?",
     r"Договор № [Номер договора] от [Дата заключения] года",
     {"contract_number", "contract_date"}),
    (r"Договор[ау]?\s*№\s*_+\s+от\s+_+\s*г\.?",
     r"Договор № [Номер договора] от [Дата заключения] г.",
     {"contract_number", "contract_date"}),

    # === Date / place: "«__» ________ 20___ года" — multiple variants ===
    (r"«_+»\s*_+\s*20_+\s*год[ау]?", r"«[День]» [Месяц] 20[Год] года",
     {"date_day", "date_month", "date_year"}),
    (r"«_+»\s*_+\s*20_+\s*г\.?", r"«[День]» [Месяц] 20[Год] г.",
     {"date_day", "date_month", "date_year"}),
    (r"«_+»_+20_+\s*г\.?", r"«[День]» [Месяц] 20[Год] г.",
     {"date_day", "date_month", "date_year"}),
    (r"«_+»\s*_+\s*202_+\s*г(\.|ода)?", r"«[День]» [Месяц] 202[Год] г.",
     {"date_day", "date_month", "date_year"}),
    (r"«_+»\s+_+\s+г\.?", r"«[День]» [Месяц] г.",
     {"date_day", "date_month"}),
    (r"_+\s+_+\s+20_+\s*год[ау]?", r"[Дата заключения] 20[Год] года",
     {"contract_date", "date_year"}),

    # === Parties — Изготовитель representative ===
    (r"в\s+лице\s+_+\s*,?\s*действующего\s+на\s+основании\s+_+\s*,?",
     r"в лице [Представитель Изготовителя], действующего на основании [Основание полномочий],",
     {"producer_rep", "producer_basis"}),

    # === Counterparty (ФЛ — Гражданин РФ) ===
    (r"Гражданин(?:ин|ин)?\s+(?:РФ|Российской\s+Федерации)\s+_+",
     r"Гражданин РФ [ФИО контрагента]",
     {"counterparty_name"}),

    # === Counterparty (ИП) ===
    (r"Индивидуальный\s+предприниматель\s+_+\s*,?\s*действующ(?:ий|его)\s+на\s+основании",
     r"Индивидуальный предприниматель [ФИО контрагента], действующий на основании",
     {"counterparty_name"}),
    (r"Индивидуальный\s+предприниматель\s+_+",
     r"Индивидуальный предприниматель [ФИО контрагента]",
     {"counterparty_name"}),
    (r"ОГРНИП\)\s+сери(?:и|я)\s*_+\s*№\s*_+\s+от\s+«_+»\s*_+\s*20_+\s*г\.?",
     r"ОГРНИП) серия [Серия ОГРНИП] № [ОГРНИП], выдано «[День ОГРНИП]» [Месяц ОГРНИП] 20[Год ОГРНИП] г.",
     {"counterparty_ogrnip"}),
    (r"ОГРНИП\s*_+", r"ОГРНИП [ОГРНИП]", {"counterparty_ogrnip"}),
    (r"ОГРН\s+ИП\s*_+", r"ОГРН ИП [ОГРНИП]", {"counterparty_ogrnip"}),

    # === Counterparty (Самозанятый) ===
    (r"плательщик(?:ом)?\s+налога\s+на\s+профессиональный\s+доход\s+_+",
     r"плательщиком налога на профессиональный доход [ФИО контрагента]",
     {"counterparty_name"}),

    # === Passport (ФЛ) ===
    (r"\(паспорт[^)]*?\)", r"(паспорт [Паспорт серия] [Паспорт номер], выдан [Кем выдан] [Дата выдачи паспорта], зарегистрирован: [Адрес регистрации])",
     {"counterparty_passport_series", "counterparty_passport_number", "counterparty_passport_issuer", "counterparty_passport_date", "counterparty_address"}),

    # === Film name ===
    (r"под\s+(?:условным|рабочим|условным\s*\(\s*рабочим\s*\))\s*(?:\(\s*рабочим\s*\)\s*)?\s*названием\s*«_+»",
     r"под рабочим названием «[Название фильма]»", {"film_name"}),
    (r"рабочим\s+названием\s*«_+»", r"рабочим названием «[Название фильма]»", {"film_name"}),
    (r"условным\s*\(?рабочим\)?\s*названием\s*«_+»", r"условным (рабочим) названием «[Название фильма]»", {"film_name"}),

    # === Director / screenwriter mentions ===
    (r"Режиссер[- ]постановщик\s*-?\s*_+", r"Режиссёр-постановщик - [Режиссёр-постановщик]", {"director"}),
    (r"автор\s+сценари[яи]\s*[–\-]\s*_+", r"автор сценария — [Автор сценария]", {"screenwriter"}),

    # === Period dates: "с___по_______20_года" ===
    (r"с\s*_+\s*по\s*_+\s*20_+\s*год[ау]?",
     r"с [Дата начала] по [Дата окончания] 20[Год] года",
     {"start_date", "end_date", "period_year"}),

    # === Title in credits: "Должность - __________"  (in titres section) ===
    # (handled per-template — too generic to safely automate)

    # === Money: "____ (_______) рублей" ===
    (r"_+\s*\(\s*_+\s*\)\s*рубл(ей|я|ь)\s*(?:00\s*коп(?:еек)?\.?)?",
     r"[Сумма цифрами] ([Сумма прописью]) рублей 00 коп.",
     {"amount_num", "amount_words"}),

    # === Simple fields in реквизиты block ===
    (r"Дата\s+рождения\s*:?\s*_+", r"Дата рождения: [Дата рождения]", {"counterparty_birth_date"}),
    (r"ИНН\s*:?\s*_+(?!\d)", r"ИНН: [ИНН контрагента]", {"counterparty_inn"}),
    (r"СНИЛС\s*:?\s*_+", r"СНИЛС: [СНИЛС]", {"counterparty_snils"}),
    (r"Зарегистрирован\s*:?\s*_+", r"Зарегистрирован: [Адрес регистрации]", {"counterparty_address"}),
    (r"Адрес(?:\s+регистрации)?\s*:?\s*_+", r"Адрес регистрации: [Адрес регистрации]", {"counterparty_address"}),
    (r"Паспорт\s*:?\s*серия\s*_+\s*№\s*_+", r"Паспорт: серия [Паспорт серия] № [Паспорт номер]",
     {"counterparty_passport_series", "counterparty_passport_number"}),
    (r"Выдан\s*:?\s*_+", r"Выдан: [Кем выдан]", {"counterparty_passport_issuer"}),
    (r"Дата\s+выдачи\s*:?\s*_+", r"Дата выдачи: [Дата выдачи паспорта]", {"counterparty_passport_date"}),
    (r"(?<![А-Яа-я])к/?п\s*:?\s*_+", r"КПП: [КПП]", {"counterparty_kpp"}),
    (r"р/?с\s*:?\s*_+", r"р/с: [Расчётный счёт]", {"counterparty_rs"}),
    (r"Банк\s*:?\s*_+", r"Банк: [Банк]", {"counterparty_bank"}),
    (r"Кор\.?\s*счет\s*:?\s*_+", r"Кор.счёт: [Корсчёт]", {"counterparty_ks"}),
    (r"БИК\s*:?\s*_+", r"БИК: [БИК]", {"counterparty_bik"}),
    (r"Телефон\s*:?\s*_+", r"Телефон: [Телефон]", {"counterparty_phone"}),
    (r"Электронная\s+почта\s*:?\s*_+", r"Электронная почта: [Email]", {"counterparty_email"}),
    (r"e-?mail\s*:?\s*_+", r"E-mail: [Email]", {"counterparty_email"}),

    # === Period in days ===
    (r"_+\s*\(\s*_+\s*\)\s*календарных\s+дней", r"[Срок цифрой] ([Срок прописью]) календарных дней",
     {"term_days_num", "term_days_words"}),
    (r"_+\s+календарных\s+дней", r"[Срок цифрой] календарных дней", {"term_days_num"}),

    # === Email "адрес электронной почты ___" ===
    (r"адрес\s+электронной\s+почты\s*_+", r"адрес электронной почты [Email Изготовителя]", {"producer_email"}),

    # === Signature lines: ____________ / __________/ ===
    (r"_{8,}\s*/\s*_{4,}\s*/", r"[Подпись] / [ФИО] /", set()),

    # === Catch-all empty ____ runs that survived → ${?:fragment} ===
    # (left for last; will be stripped to a manual-review marker)
]

def slug(name):
    n = unicodedata.normalize("NFC", name)
    n = re.sub(r"[^\w\s-]", "", n, flags=re.UNICODE)
    n = re.sub(r"\s+", "_", n).strip("_")
    return n[:200]

def detect_tax_form(filename):
    n = filename.lower()
    if "самозанят" in n: return "СЗ"
    if "_ип." in n or "_ип_" in n or "ип_и_фл" in n or "ип_или_фл" in n or "(ип)" in n: return "ИП"
    if "_фл." in n or "_фл_" in n or "(фл)" in n or "фл_или_ип" in n: return "ФЛ"
    if "_юл" in n or "(юл)" in n: return "ЮЛ"
    if "до_14" in n: return "ФЛ_до14"
    if "от_14" in n: return "ФЛ_14_17"
    return "?"

def convert(text):
    """Apply all substitutions and return (md_text, set_of_used_fields, remaining_unknown_count)."""
    used = set()
    for pattern, replacement, keys in SUBS:
        new_text, n_subs = re.subn(pattern, replacement, text)
        if n_subs > 0:
            text = new_text
            used.update(keys)
    # Count remaining underscores (unfilled placeholders)
    remaining = re.findall(r"_{2,}", text)
    # Replace remaining with [?] marker (for manual review later)
    text = re.sub(r"_{4,}", "[?]", text)
    return text, used, len(remaining)

def main():
    summary = []
    for txt_file in sorted(SRC.iterdir()):
        if not txt_file.suffix == ".txt":
            continue
        # Skip our own test artifact
        if "без_имени" in txt_file.stem.lower():
            continue
        text = txt_file.read_text(encoding="utf-8")
        md_text, used, remaining = convert(text)
        out_name = txt_file.stem + ".md"
        out_path = DST / out_name
        out_path.write_text(md_text, encoding="utf-8")
        summary.append({
            "file": txt_file.stem,
            "tax_form": detect_tax_form(txt_file.stem),
            "size_chars": len(text),
            "fields_used": sorted(used),
            "remaining_blanks": remaining,
        })
    # Write summary
    (DST / "_conversion_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    # Print quick stats
    total_used = set()
    for s in summary:
        total_used.update(s["fields_used"])
    print(f"Converted {len(summary)} files")
    print(f"Total unique field keys used: {len(total_used)}")
    print(f"Field keys: {sorted(total_used)}")
    print(f"Avg remaining blanks per template: {sum(s['remaining_blanks'] for s in summary)/max(len(summary),1):.1f}")
    high_remaining = [s for s in summary if s["remaining_blanks"] > 30]
    if high_remaining:
        print(f"\n⚠ Templates with >30 unresolved blanks ({len(high_remaining)}):")
        for s in high_remaining[:10]:
            print(f"  {s['remaining_blanks']:3d}  {s['file']}")

if __name__ == "__main__":
    main()
