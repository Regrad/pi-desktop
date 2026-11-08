# Проверка нового инструмента генерации 3D — 08.11.2026

Источник цепочки: https://github.com/pixelartistry/PixelArtistry-Animated-Characters

## Что заменено

Встроенная цепочка `media_generate_3d`: генерация формы → подготовка замкнутой
сетки → LODTailor → запекание normal map с плотной сетки → UltraTex PBR → GLB.
Старое текстурирование из этого инструмента удалено. Отдельный инструмент
текстурирования существующих моделей не менялся.

Вход: одна картинка или четыре отдельных ракурса. Сохранены управление числом
треугольников, размером текстур, seed, разрешением геометрии/реконструкции,
компонентами и дополнительной обработкой. Доступен выбор Pixal3D/Trellis2
для одной картинки; четыре ракурса используют Pixal3D. Параметры сэмплера
приведены к реальным возможностям нового UltraTex; стандартный attention старого
узла не предлагается как будто он поддерживается новым sparse-сэмплером.

ComfyUI обновлён до 0.39.2: старое ядро 0.37.0 не имело нужных интерфейсов Flux.
PyTorch оставлен 2.8.0+cu128 для совместимости с WTiVo. Пользовательские узлы,
веса и данные сохранены. UltraTex Modular закреплён на
`8b3715605fa5f08d4de7f858d3ba8c16f94e7b0c`; ComfyUI-GGUF — `4dfc025`.

## Проверки

- Четыре ракурса прежнего персонажа: полный прогон до GLB; 50 000 треугольников,
  одна замкнутая компонента после сварки дубликатов UV, normal/base color/MR 2K.
  Четвёртый ракурс — зеркало единственного бокового референса, не независимый вид.
- Выявлено несоответствие ориентации четырёхвидового меша и фронтальной камеры
  UltraTex. Проверено отдельными рендерами без материалов и повторным
  текстурированием готовой сетки. Исправлено штатным Rotate Mesh перед UltraTex,
  без повторной реконструкции и изменения UV. Лицо больше не рисуется на затылке.
- Основной качественный тест — новый гладкий референс, сгенерированный imagegen:
  [изображение](assets/pixelartistry-character-reference.png).
- Реальный вызов зарегистрированного `media_generate_3d`: seed 56, цель 50 000,
  карты 2048, штатные остальные настройки; серверный прогон **330.27 с**.
- Результат: **49 990 треугольников**, 37 080 вершин с UV-разрывами,
  24 993 после позиционной сварки; **одна замкнутая компонента**,
  согласованное направление граней; base color, normal, metallic/roughness — 2048².
- Проверены CPU-рендеры спереди и сзади: без второй головы/лица на затылке,
  без исходной стилизации под нарисованные полигональные грани.
- Топология проверялась на копии в памяти; сварка UV-дубликатов использовалась
  только для анализа и не переписывала результат.
- Автотесты проверяют оба режима, параметры, реальные схемы узлов, публикацию
  GLB, структуру отчёта и сохранение отдельных инструментов обработки.

Тестовая модель и рендеры: `exports/pixelartistry-validation-20261108/`.
SHA-256 GLB: `13620e8f854aa25c355b60988f4f10e8d0add0cff8953842211fbd485df22cc3`.
Проверка не подтверждает пригодность любой генерации для рига, отсутствие
всех возможных артефактов или коммерческие права на использование весов.

## Промпт референса

Использован встроенный imagegen, не локальная генерация ComfyUI:

```text
Use case: stylized-concept. Create ONE clean high-quality front-view reference image for testing an image-to-3D character reconstruction pipeline. A single adult male fantasy adventurer, fit but naturally proportioned, short dark brown hair, clean shaven, neutral expression. Wearing a plain fitted muted teal long-sleeve tunic with visible subtle fabric weave, a simple narrow leather belt, fitted dark gray trousers and simple brown leather boots. Empty bare hands, fingers clearly separated, no accessories or weapons. Full body including all hair and boot soles, standing straight in a symmetrical relaxed A-pose with arms about 35 degrees from torso, legs comfortably separated, facing camera directly. Orthographic front view, centered with generous clear margins. High-resolution smooth sculpted 3D-render appearance with continuous curved anatomy and smooth shading, genuinely smooth surfaces rather than flat polygonal facets; enough realistic material detail to evaluate skin, cloth and leather, but no distracting pattern. Flat uniform light gray background. Soft broad neutral studio illumination, low contrast, no hard directional shadows or baked dramatic highlights. No text, no logos, no extra characters, no collage or turnaround sheet, no low-poly or faceted aesthetic. This is a geometric and texture-quality test reference, not a posed cinematic illustration.
```
