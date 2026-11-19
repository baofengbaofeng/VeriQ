# README

本目录保存用户确认的 VeriQ 品牌图形、可缩放矢量稿，以及高对比度的系统菜单栏图标。

## 资源清单

| 文件 | 规格 | 用途 |
| --- | --- | --- |
| [veriq-logo.png](veriq-logo.png) | 1254 × 1254 PNG | 用户确认的原始图稿，保留白色画布与边距 |
| [veriq-logo.svg](veriq-logo.svg) | 矢量，1024 × 1024 画布 | 彩色主标志，深靛蓝背景与冰蓝至青绿色 V/Q 图形 |
| [veriq-logo-1024.png](veriq-logo-1024.png) | 1024 × 1024 PNG | 从矢量稿导出的彩色图标，圆角外部透明 |
| [verifyquality-logo-light.svg](verifyquality-logo-light.svg) | 矢量，474 × 114 透明画布 | 浅色背景用，原版彩色图标配深蓝色 VerifyQuality 字标 |
| [verifyquality-logo-light.png](verifyquality-logo-light.png) | 948 × 228 透明 PNG，2× | 浅色背景用的横版标志 |
| [verifyquality-logo-dark.svg](verifyquality-logo-dark.svg) | 矢量，474 × 114 透明画布 | 深色背景用，原版彩色图标配浅蓝与青绿色 VerifyQuality 字标 |
| [verifyquality-logo-dark.png](verifyquality-logo-dark.png) | 948 × 228 透明 PNG，2× | 深色背景用的横版标志 |
| [veriq-menubar.svg](veriq-menubar.svg) | 矢量，22 × 22 画布 | 透明背景的纯黑 V/Q 图形 |
| [veriq-menubar-white.svg](veriq-menubar-white.svg) | 矢量，22 × 22 画布 | 透明背景的纯白 V/Q 图形 |
| [veriq-menubarTemplate.png](veriq-menubarTemplate.png) | 22 × 22 PNG，1× | macOS 菜单栏黑色模板图标 |
| [veriq-menubarTemplate@2x.png](veriq-menubarTemplate@2x.png) | 44 × 44 PNG，2× | macOS Retina 菜单栏黑色模板图标 |
| [veriq-menubar-white.png](veriq-menubar-white.png) | 22 × 22 PNG，1× | 深色系统栏使用的白色图标 |
| [veriq-menubar-white@2x.png](veriq-menubar-white@2x.png) | 44 × 44 PNG，2× | 深色系统栏使用的高分辨率白色图标 |

`veriq-logo.png` 是原始文件的逐字节副本，继续保留作确认稿。
SVG 以真实贝塞尔路径和渐变重建相同设计，未嵌入位图、字体或外部资源；曲线版本去掉了外部白色画布。
矢量稿保持确认稿的轮廓和色系，其栅格导出与原始生成图不要求逐像素相同。

两款 VerifyQuality 横版标志均保留彩色图标的靛蓝圆角底形，图标和字标以外的画布为透明。
字标已转为矢量路径，可直接用于网页和文档，无需安装字体。

菜单栏版只保留 V/Q 图形，采用透明画布与纯黑或纯白填充；边缘通过透明度抗锯齿。
22 × 22 画布中的主体宽度为 18，留出系统栏所需的呼吸空间。

## macOS 菜单栏接入

将 `veriq-menubarTemplate.png` 与同名 `@2x` 文件一起放入桌面发行资源目录。
宿主从实际资源路径加载图标，并显式声明为模板图像：

```ts
const icon = nativeImage.createFromPath(
    path.join(assetDirectory, "veriq-menubarTemplate.png"),
);
icon.setTemplateImage(true);
const tray = new Tray(icon);
```

`assetDirectory` 应由桌面宿主按安装布局解析。macOS 使用模板的透明度轮廓，
根据浅色、深色及菜单栏状态调整显示颜色；保留文件名中的 `Template` 和 `@2x` 大小写。
Windows/Linux 托盘宿主可按实际系统栏背景选择黑色或白色 PNG，并按缩放比例选择尺寸。

这些文件提供图形素材和接入示例；系统菜单栏加载、深浅主题切换与 Retina 显示仍由目标系统验收。

## 从 SVG 重新导出 PNG

本次使用 Inkscape 1.4 导出。以下命令在仓库根目录执行，复用现有工具，不安装项目运行时依赖：

```sh
export INKSCAPE_PROFILE_DIR="${TMPDIR:-/tmp}/veriq-branding-inkscape"
mkdir -p "$INKSCAPE_PROFILE_DIR"
inkscape assets/branding/veriq-logo.svg \
    --export-area-page --export-background-opacity=0 \
    --export-width=1024 --export-height=1024 \
    --export-filename=assets/branding/veriq-logo-1024.png

for theme in light dark; do
    inkscape "assets/branding/verifyquality-logo-${theme}.svg" \
        --export-area-page --export-background-opacity=0 \
        --export-width=948 --export-height=228 \
        --export-filename="assets/branding/verifyquality-logo-${theme}.png"
done

for size in 22 44; do
    suffix=""
    if [ "$size" = 44 ]; then
        suffix="@2x"
    fi
    inkscape assets/branding/veriq-menubar.svg \
        --export-area-page --export-background-opacity=0 \
        --export-width="$size" --export-height="$size" \
        --export-filename="assets/branding/veriq-menubarTemplate${suffix}.png"
    inkscape assets/branding/veriq-menubar-white.svg \
        --export-area-page --export-background-opacity=0 \
        --export-width="$size" --export-height="$size" \
        --export-filename="assets/branding/veriq-menubar-white${suffix}.png"
done
```

修改图形时先更新 SVG，再统一导出对应 PNG；原始确认稿 `veriq-logo.png` 保持不变。
