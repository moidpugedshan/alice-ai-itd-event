#!/usr/bin/env python3
"""
Сборка одиночного HTML-файла из src/.

Берёт src/index.html и подставляет на место ссылок содержимое файлов:
    js/mock-runtime.js  -> <script>…</script>
    js/app.js           -> <script type="module" crossorigin>…</script>
    styles/app.css      -> <style rel="stylesheet" crossorigin>…</style>

Результат: waste-paper.html в корне проекта — один самодостаточный файл,
который открывается в браузере двойным кликом, без сервера и интернета.

Запуск:
    python3 scripts/build.py
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
OUT = ROOT / "waste-paper.html"

# Обрамление блоков — как в собранном файле
SLOTS = [
    (
        '<script src="js/mock-runtime.js"></script>',
        "js/mock-runtime.js",
        "<script>\n{}\n\n        </script>",
    ),
    (
        '<script type="module" src="js/app.js"></script>',
        "js/app.js",
        '<script type="module" crossorigin>\n{}\n        </script>',
    ),
    (
        '<link rel="stylesheet" href="styles/app.css">',
        "styles/app.css",
        '<style rel="stylesheet" crossorigin>\n{}\n        </style>',
    ),
]


def main() -> None:
    html = (SRC / "index.html").read_text(encoding="utf-8")

    for placeholder, relpath, template in SLOTS:
        if placeholder not in html:
            raise SystemExit(f"в src/index.html не найдена ссылка: {placeholder}")
        code = (SRC / relpath).read_text(encoding="utf-8")
        # в файлах лежит ровно тот текст, что и в сборке, плюс завершающий перевод строки
        assert code.endswith("\n"), f"{relpath}: файл должен заканчиваться переводом строки"
        code = code[:-1]
        html = html.replace(placeholder, template.format(code), 1)

    OUT.write_text(html, encoding="utf-8")
    print(f"собрано: {OUT.relative_to(ROOT)} ({OUT.stat().st_size} байт)")


if __name__ == "__main__":
    main()
