# CWSP-shell

Домашний экран и Speed Dial U2RE: **Android Launcher** (Capacitor) и та же среда как **New Tab** в Chrome через [`CWSP-crx`](../CWSP-crx/).

## Платформы

| Поверхность | Роль |
| --- | --- |
| Android / Capacitor | Launcher SKU: сетка, список приложений, shortcuts, виджеты, нативные иконки. |
| Chrome / CWSP-crx | New Tab (`chrome_url_overrides.newtab`) с тем же Speed Dial. |
| PWA / Chromium | Веб-среда во вкладке или установленной PWA. |

## Возможности

- Несколько рабочих сторон, ярлыки (сайты, views, файлы, Android-приложения, действия).
- Drag-and-drop ссылок, файлов и изображений; картинку можно положить в обои.
- Сетка, размер и форма плиток, масштаб и способ иконок.
- App Menu: сведения о приложении, системные настройки Android, правка запуска (action / data / extras / flags), удаление пакета через системный лист.
- На Android: Home/Launcher, adaptive icons и икон-паки, виджеты, цвет из обоев / Material You / ручной оттенок.
- Environment-shell: taskbar, статусная строка, плавающие окна, Settings, Explorer, Viewer.

Контрольная панель (Control) к launcher не относится — она у transfer / gateway.

## Команды

Node.js **24+**.

```bash
cd apps/CWSP-shell
npm run dev
npm run build                          # PWA
npm run build:capacitor:launcher       # APK без bump версии
npm run build:capacitor:apk:release
npm run build:crx                      # делегирует в apps/CWSP-crx
```

## Структура

```text
apps/CWSP-shell/
├── src/frontend/web/capacitor-launcher/
├── src/java/space/u2re/cwsp/          # launcher bridge, виджеты
├── platforms/android/
├── scripts/
└── build/                             # артефакты, не редактировать
```

UI SoT: `fest/fl-ui` (Speed Dial, App Menu, taskbar), `fest/lure` / `fest/object`, `fest/veela`, `fest/icon`, `subsystem`.
