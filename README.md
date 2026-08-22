# CWSP-shell

**CWSP-shell** — единая среда домашнего экрана и Speed Dial для U2RE. Она работает как Android Launcher через Capacitor и как рабочее пространство новой вкладки Chrome через расширение CWSP-crx.

Проект превращает обычную сетку ярлыков в настраиваемую локальную среду: с обоями, рабочими сторонами, Android-приложениями, быстрыми действиями, адаптивной темой и встроенными инструментами CWSP.

## Платформы

| Поверхность | Роль |
| --- | --- |
| **Android / Capacitor** | Launcher SKU: домашний экран, список приложений, app shortcuts, Android-виджеты и нативные иконки. |
| **Chrome / CWSP-crx** | New Tab Page с тем же Speed Dial и environment-shell. Расширение использует `chrome_url_overrides.newtab`. |
| **PWA / Chromium** | Веб-версия среды для запуска во вкладке или установленной PWA. |

`CWSP-shell` содержит общую shell-логику. [`CWSP-crx`](../CWSP-crx/) — Manifest V3-оболочка, которая подключает её к новой вкладке Chrome.

## Возможности

### Speed Dial как рабочее пространство

- Несколько рабочих сторон: **Side A**, **Side B**, **Side C** и дополнительные страницы.
- Ярлыки на сайты, внутренние представления CWSP, файлы, Android-приложения и действия.
- Копирование, вставка, дублирование и отправка ярлыков на другую сторону.
- Переносимый формат ярлыка: подпись, иконка, действие и свойства сохраняются вместе.
- Drag-and-drop ссылок, файлов и изображений; изображение можно применить как обои.
- Настраиваемые сетка, размер плиток, форма, масштаб и способ отображения иконок.

### Android Launcher

- Может быть назначен приложением Home / Launcher.
- Список установленных приложений, запуск Activity и поддержка app shortcuts.
- Android-виджеты прямо на рабочем столе.
- Нативные иконки приложений, варианты adaptive icon и икон-паки, если их поддерживает устройство.
- Прозрачные системные панели поверх обоев без скрытия Back / Home / Recents.
- Основной цвет из обоев, **Material You**, системных обоев или пользовательского оттенка.

### Environment shell

- App Menu, taskbar и статусная строка для быстрого доступа к задачам.
- Плавающие окна и режимы открытия представлений.
- Settings для темы, внешнего вида, сетки, ярлыков и платформенных параметров.
- Explorer для локального виртуального хранилища и Viewer для Markdown/документов.
- Сетевая диагностика для поддерживаемых CWSP-поверхностей.

## Визуальный стиль

CWSP-shell использует адаптивные дизайн-токены: плитки, меню, taskbar и окна получают общий seed-цвет, а не отдельные жёстко заданные темы.

На Android источник цвета можно переключать между обоями, системной палитрой Material You и ручным выбором. Пока нативная иконка приложения загружается, плитка остаётся пустой — без вспышки временного значка смартфона или серого квадрата.

## Быстрый старт

Требования: Node.js **24+** и зависимости workspace.

```bash
cd apps/CWSP-shell
npm run dev
```

Сборка Android Launcher:

```bash
npm run build:capacitor:launcher

# Release APK
npm run build:capacitor:apk:release
```

Сборка Chrome-расширения:

```bash
npm run build:crx
```

`build:crx` запускает сборку соседнего приложения `apps/CWSP-crx`, где находятся Manifest V3 и Chrome New Tab override.

## Структура

```text
apps/CWSP-shell/
├── src/frontend/web/capacitor-launcher/  # Android / Capacitor entry point
├── src/java/space/u2re/cwsp/             # нативный bridge, Launcher и виджеты
├── platforms/android/                    # Android project Capacitor
├── scripts/                              # build, sync и APK tooling
└── build/                                # generated artifacts — не редактировать
```

Общая UI-логика живёт в библиотеках workspace:

- `fest/fl-ui` — Speed Dial, taskbar, App Menu, плитки и окна;
- `fest/lure` и `fest/object` — DOM/UI-реактивность;
- `fest/veela` — дизайн-токены и адаптивная тема;
- `fest/icon` — glyph, resource и bitmap-иконки;
- `subsystem` — настройки, bridge и платформенные интеграции.

## Совместимость

- Android: минимальный SDK 24; системный акцент Material You доступен на Android 12+.
- Chrome/Chromium: актуальные Chrome и Edge; расширение использует Manifest V3.
- Приложения, виджеты, икон-паки и системные ярлыки зависят от версии Android, устройства и выданных разрешений.

## Статус

CWSP-shell — активно развиваемая экспериментальная среда. Основной фокус: быстрый, личный и адаптивный home/new-tab опыт с одной моделью данных для Android и Chromium.
