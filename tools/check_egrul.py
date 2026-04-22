#!/usr/bin/env python3
"""
Проверка контрагента по ИНН/ОГРН через открытые источники.
Использование:
    ./check_egrul.py <ИНН-или-ОГРН>
"""
import sys
import json
import urllib.request
import urllib.parse


def normalize(q: str) -> str:
    return "".join(ch for ch in q if ch.isdigit())


def query_egrul(q: str):
    """
    Публичный API ФНС egrul.nalog.ru (поиск)
    """
    url = "https://egrul.nalog.ru/"
    # ФНС использует POST с токеном; базовая проверка без JS сложная.
    # Выдаём прямую ссылку на поиск — модель сама прочитает через web_fetch.
    search_url = f"https://egrul.nalog.ru/index.html?query={urllib.parse.quote(q)}"
    return {
        "query": q,
        "egrul_search_url": search_url,
        "hint": "Правоеб: открой URL через web_fetch или direct fetch JSON API ниже."
    }


def main():
    if len(sys.argv) < 2:
        sys.exit("Укажи ИНН или ОГРН: ./check_egrul.py 7700000000")
    q = normalize(sys.argv[1])
    if len(q) not in (10, 12, 13, 15):
        sys.exit(f"Не похоже на ИНН/ОГРН: {q}")
    print(json.dumps(query_egrul(q), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
