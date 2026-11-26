/**
 * 执行环境页面通过共同资源编辑器提供环境版本管理，运行计划可以引用已发布版本，认证与凭证由工作区设置管理。
 */

import { ResourcePage } from "../resources/ResourcePage";
/**
 * 固定资源类型并为环境路由保留独立挂载点，切换其他资源页面时不会沿用上一类资源的筛选和编辑状态。
 */
export function EnvironmentPage() {
    return <ResourcePage fixedKind="ENVIRONMENT" />;
}
