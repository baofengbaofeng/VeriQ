import path from "node:path";

/** 打包资源路径只相对固定 renderer 根解析，返回值还必须由调用方执行普通文件与符号链接检查；路径运算可注入 Windows 或 POSIX 语义供交叉平台回归，不允许页面选择另一个静态根目录。 */
export function bundledAssetPath(
    assets: string,
    pathname: string,
    paths: typeof path = path,
): string | undefined {
    const target = paths.resolve(assets, "." + pathname);
    const relative = paths.relative(assets, target);
    if (
        !relative ||
        relative === ".." ||
        relative.startsWith(".." + paths.sep) ||
        paths.isAbsolute(relative)
    )
        return undefined;
    return target;
}
