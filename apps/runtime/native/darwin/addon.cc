/** Node-API 适配只封装有限目录与普通文件拥有者，不导出构造任意整数描述符的接口；同步操作失败转换成固定英文代码、阶段和 errno，Buffer 正文与配置路径不进入异常消息。
 * 原生拥有者保存在 ObjectWrap 内，File 的 fd getter 只借出当前活描述符。
 * 正式模块没有故障调度导出，独立测试目标通过自己的初始化器增加测试能力。
 */
#include <napi.h>
#include <cmath>
#include "private-files.h"

namespace veriq::darwin {
/** 每个边界调用都显式捕获原生失败，避免系统异常跨过 Node-API ABI 或把秘密拼进消息；未知 C++ 异常使用同一内部错误码，JavaScript 测试回调异常仍原样保留以暴露断言失败。
 * code 为 ENOENT 的唯一来源是实际 errno，不根据字符串路径或错误消息猜测缺失。
 * phase 仅取实现中的固定字面量，不包含成员名。
 */
template<class Call> Napi::Value boundary(Napi::Env env, Call call) {
    try { return call(); }
    catch (const Failure& failure) {
        auto error = Napi::Error::New(env, failure.what());
        error.Set("code", failure.what());
        error.Set("phase", failure.phase);
        error.Set("errno", Napi::Number::New(env, failure.number));
        error.ThrowAsJavaScriptException();
    } catch (const Napi::Error& error) { error.ThrowAsJavaScriptException(); }
    catch (...) {
        auto error = Napi::Error::New(env, "DARWIN_PRIVATE_INTERNAL");
        error.Set("code", "DARWIN_PRIVATE_INTERNAL");
        error.ThrowAsJavaScriptException();
    }
    return env.Undefined();
}

/** JavaScript 字符串在转换 UTF8 前先拒绝孤立代理码元，防止 Node 替换字符让传入名称与实际定位名称不同；合法补充平面码点仍按原编码传递，组件字节限制由 POSIX 层继续检查。
 * 所有公开成员参数必须为真正字符串，不执行用户自定义 toString。
 * 非法 Unicode 的错误只指出参数阶段，不泄漏原字符串。
 */
std::string text(const Napi::Value& value) {
    require(value.IsString(), "argument.string");
    const auto string = value.As<Napi::String>();
    const auto units = string.Utf16Value();
    for (size_t i = 0; i < units.size(); i++) {
        if (units[i] >= 0xd800 && units[i] <= 0xdbff) {
            require(i + 1 < units.size() && units[i + 1] >= 0xdc00 && units[i + 1] <= 0xdfff,
                "argument.unicode");
            i++;
        } else require(units[i] < 0xdc00 || units[i] > 0xdfff, "argument.unicode");
    }
    return string.Utf8Value();
}
/** 数值额度先要求真正 Number 再检查有限、整数与当前 API 的上下界，避免 NaN 或无穷在转换 size_t 时绕过边界；枚举唯一允许零额度，文件读取仍要求正数并保留两兆硬上限。
 * 不执行 valueOf，因此调用者自定义对象不会在检查期间重入文件操作。
 * maximum 来自固定原生常量，不由 JavaScript 提供。
 * 转换发生在完整范围检查之后，负数和小数无法截断成其他有效值。
 * 大于安全整数的值早已超出本 API 最大额度并被拒绝。
 * 传入错误统一定位 argument.limit，正文或路径不会进入错误消息。
 */
size_t limit(const Napi::Value& value, size_t maximum, size_t minimum = 1) {
    require(value.IsNumber(), "argument.limit");
    const double number = value.As<Napi::Number>().DoubleValue();
    require(std::isfinite(number) && number >= minimum && number <= maximum &&
        std::floor(number) == number, "argument.limit");
    return static_cast<size_t>(number);
}

/** 内部转移令牌使用 Node-API External 携带独占原生对象，JavaScript 无法用整数伪造令牌；External 终结器负责构造异常时残留的唯一拥有者，成功构造后对象已经移动到对应 ObjectWrap。
 * 构造器引用由本次模块初始化创建并在环境结束清理，不占用其他 addon 的环境实例数据。
 * 两个类不作为模块导出，反射得到构造器也仍须通过不可伪造的内部令牌。
 */
template<class Core> using Transfer = std::unique_ptr<Core>;
struct Constructors {
    Napi::FunctionReference directory;
    Napi::FunctionReference file;
};
/** 包装文件拥有者时先把独占指针交给带终结器的 External，再由内部构造器移动进 ObjectWrap，任一阶段异常都仍有明确资源拥有者；JavaScript 得不到 External，因此不能用已有数字重建授权对象。
 * constructor 是当前模块内部保存的真实类函数，外部同名属性不能替换它。
 * 成功构造后 transfer 为空，External 最终释放不会再次关闭文件。
 * 构造失败时 transfer 仍持有资源，终结器只负责兜底释放。
 * 文件对象本身是父层保活单位，不能用 fd getter 的返回值替代。
 * 返回 Object 时没有按原路径重新打开文件，也不复制描述符。
 */
template<class Core> Napi::Object wrap(Napi::Env env, Napi::FunctionReference& constructor,
        std::unique_ptr<Core> value) {
    auto* transfer = new Transfer<Core>(std::move(value));
    auto token = Napi::External<Transfer<Core>>::New(env, transfer,
        [](Napi::Env, Transfer<Core>* owned) { delete owned; });
    return constructor.New({token});
}

/** 普通文件包装保留原生 File 的强所有权，get fd 只读取活对象而不转移或复制关闭责任；C2 必须把此对象一直保活到实际 CLI 退出且最终校验结束，不能仅保存本 getter 返回的数字。
 * 读取返回独立 Buffer，原生临时向量离开后不会留下悬空内存。
 * close 的幂等性由底层先撤销状态实现，包装层不添加会误关复用 fd 的重试。
 */
class FileWrap : public Napi::ObjectWrap<FileWrap> {
    std::unique_ptr<File> value_;
public:
    /** 文件构造器只接受原生创建的唯一 External 转移令牌，反射调用没有令牌时抛标准 JavaScript 类型错误；该验证不让自定义 Failure 越过构造回调，也不产生可操作的空文件对象。
     * 原生指针只从该模块内部令牌取得，不接受 Number、Buffer 或对象属性。
     * 移动令牌后原令牌为空，不能重复产生两个关闭拥有者。
     * 类型错误消息固定，不转储传入对象。
     * 失败对象不会交付给正常调用者，也没有数字 fd 后备。
     */
    explicit FileWrap(const Napi::CallbackInfo& info) : Napi::ObjectWrap<FileWrap>(info) {
        if (info.Length() != 1 || !info[0].IsExternal()) {
            Napi::TypeError::New(info.Env(), "DARWIN_PRIVATE_CONSTRUCTOR").ThrowAsJavaScriptException();
            return;
        }
        value_ = std::move(*info[0].As<Napi::External<Transfer<File>>>().Data());
        if (!value_) Napi::TypeError::New(info.Env(), "DARWIN_PRIVATE_CONSTRUCTOR").ThrowAsJavaScriptException();
    }
    /** fd getter 只返回当前原生文件拥有者仍持有的数字，关闭后的访问由底层明确拒绝；读取数字不会转移关闭责任或保持垃圾回收存活，未来 C2 必须另外保留这个 File 对象强引用。
     * 借用仅用于 Node 显式 stdio 数组，不提供任意系统调用分派。
     * 返回类型 Number 足以精确保存本机文件描述符整数。
     * 底层 getter 的失败通过统一错误边界传回 JavaScript。
     * 不读取路径或从其他模块查询一个看似相同的 fd。
     */
    Napi::Value fd(const Napi::CallbackInfo& info) {
        return boundary(info.Env(), [&]() -> Napi::Value {
            return Napi::Number::New(info.Env(), value_->fd());
        });
    }
    /** File.read 只接受单个有限额度并在原始 inode 上定位读取完整字节，结果复制为独立 Node Buffer；CLI 推进的共享 offset 不影响此操作，暂时 EOF 也不会被包装层当成进程退出或 SEAL 证明。
     * limit 在进入底层前先通过 Number 与整数检查。
     * 底层再次核文件身份、长度及前后元数据变化。
     * Copy 完成后原生向量可以销毁，不留下悬空 Buffer。
     * 公开方法不接受调用方提供的整数文件描述符。
     */
    Napi::Value read(const Napi::CallbackInfo& info) {
        return boundary(info.Env(), [&]() -> Napi::Value {
            require(info.Length() == 1, "file.read.arguments");
            const auto bytes = value_->read(limit(info[0], maximumBytes));
            return Napi::Buffer<uint8_t>::Copy(info.Env(), bytes.data(), bytes.size());
        });
    }
    /** File.close 拒绝额外参数并仅关闭当前 ObjectWrap 所拥有的文件对象，重复调用仍委托底层幂等撤销；系统错误保持可见且不会在 JavaScript 层自动重试那个已经可能复用的数字。
     * close 不代表 CLI 已结束，生命周期顺序仍由宿主控制。
     * 此方法不关闭目录对象或其他已创建日志。
     * 返回 undefined 只在底层没有失败时产生。
     * 对象继续存活时也不能通过 getter 重新取回已关闭数字。
     */
    Napi::Value close(const Napi::CallbackInfo& info) {
        return boundary(info.Env(), [&]() -> Napi::Value {
            require(info.Length() == 0, "file.close.arguments");
            value_->close();
            return info.Env().Undefined();
        });
    }
    /** 文件类只注册只读 fd accessor 和 read/close 两个有限方法，构造函数保留在内部模块引用而不作为公开导出；反射获得该函数仍受到 External 令牌检查，不能构造任意整数授权对象。
     * 不提供 fd setter、seek、任意 write 或 adopt 接口。
     * 原生 File 持续保留独占关闭责任。
     * 所有方法通过 ObjectWrap 接收真实实例而非用户指定句柄。
     */
    static Napi::Function define(Napi::Env env) {
        return DefineClass(env, "PrivateFile", {
            InstanceAccessor("fd", &FileWrap::fd, nullptr),
            InstanceMethod("read", &FileWrap::read), InstanceMethod("close", &FileWrap::close),
        });
    }
};

/** 私有目录包装逐项验证参数数量和有限额度，正式成员用途语法继续由上层 Records/VaultFiles 保留；原生仅识别有限组件和元数据，不根据 JSON 内容或停止状态授权任何进程结论。
 * entries 暴露名字及 overflow，不静默过滤未知成员。
 * replace 的 existingLimit 与新 Buffer 的两兆上限分离，避免扩大已有小配置的授权。
 * 返回的 File 使用独立 ObjectWrap 生命周期，不依赖目录对象继续存活。
 */
class DirectoryWrap : public Napi::ObjectWrap<DirectoryWrap> {
    std::unique_ptr<Directory> value_;
    Napi::FunctionReference fileConstructor_;
public:
    /** 目录构造器只接受内部 Directory 转移令牌和当前模块的 File 构造引用，两个参数都不会通过公开打开函数暴露；普通 JavaScript 反射构造失败保持类型错误，不会创建按路径回退的空会话。
     * File 构造引用绑定本模块，不占用其他 addon 的环境实例数据槽。
     * 目录指针移动后只由此 ObjectWrap 管理关闭。
     * 该对象不保存用户传入的原始整数或环境配置路径。
     * 公开 open 函数已经执行完整真实目录链检查。
     */
    explicit DirectoryWrap(const Napi::CallbackInfo& info) : Napi::ObjectWrap<DirectoryWrap>(info) {
        if (info.Length() != 2 || !info[0].IsExternal() || !info[1].IsFunction()) {
            Napi::TypeError::New(info.Env(), "DARWIN_PRIVATE_CONSTRUCTOR").ThrowAsJavaScriptException();
            return;
        }
        value_ = std::move(*info[0].As<Napi::External<Transfer<Directory>>>().Data());
        fileConstructor_ = Napi::Persistent(info[1].As<Napi::Function>());
        if (!value_) Napi::TypeError::New(info.Env(), "DARWIN_PRIVATE_CONSTRUCTOR").ThrowAsJavaScriptException();
    }
    /** 目录 read 要求名字和额度恰好两个参数，原生检查单组件后在持有目录内打开真实文件并有界读取；返回 Buffer 仍由业务层进行用途解析，包装层不根据 JSON 状态放宽任何权限或停止语义。
     * 字符串先检查孤立代理码元，再按 UTF8 字节限制组件长度。
     * Number 额度受两兆上限约束，正式消费者继续传更小限制。
     * 返回内容复制离开原生临时向量，不泄漏原生文件描述符。
     * 缺失与其他错误由同一 boundary 保留不同代码。
     */
    Napi::Value read(const Napi::CallbackInfo& info) {
        return boundary(info.Env(), [&]() -> Napi::Value {
            require(info.Length() == 2, "directory.read.arguments");
            const auto bytes = value_->read(text(info[0]), limit(info[1], maximumBytes));
            return Napi::Buffer<uint8_t>::Copy(info.Env(), bytes.data(), bytes.size());
        });
    }
    /** 枚举包装只允许零到八千一百九十二的安全整数，原生至多观察限额外一个条目并保留 overflow；返回完整有限名字数组而不排序截断，TS 仍能拒绝未知成员或识别专用 staging。
     * 零额度的空数组必须结合 overflow 判断，不能单独代表目录为空。
     * 每次扫描使用原生独立游标，之前的 empty 调用不影响结果。
     * Napi 数组长度来自原生已限额向量，不由目录无限增长决定。
     * 条目元数据失败直接抛出，不制造部分成功名单。
     */
    Napi::Value entries(const Napi::CallbackInfo& info) {
        return boundary(info.Env(), [&]() -> Napi::Value {
            require(info.Length() == 1, "directory.entries.arguments");
            const auto result = value_->entries(limit(info[0], maximumEntries, 0));
            auto entries = Napi::Array::New(info.Env(), result.names.size());
            for (size_t i = 0; i < result.names.size(); i++) entries.Set(i, result.names[i]);
            auto object = Napi::Object::New(info.Env());
            object.Set("names", entries);
            object.Set("overflow", result.overflow);
            return object;
        });
    }
    /** 独占创建只接受一个有限成员名，原生完成同 inode 核验及文件和父目录刷新后才包装返回 File；重名错误不会转换成已有成员读取，也不会让调用者指定原始数字或创建模式来扩大授权。
     * File 使用本目录内部保留的构造引用，生产与测试模块可同时加载。
     * 文件拥有者独立于目录存活，目录关闭不会代替 File.close。
     * 返回前发生异常仍由原生清理规则处理确切自有 inode。
     * 普通隐式 fork 不因这个方法获得可继承写能力。
     */
    Napi::Value createExclusive(const Napi::CallbackInfo& info) {
        return boundary(info.Env(), [&]() -> Napi::Value {
            require(info.Length() == 1, "directory.create.arguments");
            return wrap(info.Env(), fileConstructor_,
                value_->createExclusive(text(info[0])));
        });
    }
    /** 替换包装要求正式名字、随机临时名字、真实 Buffer 和已有成员额度四个参数，底层另核新正文两兆上限；不接受隐式字符串转换或回调写入，因此提交不确定后没有可被自动重放的业务副作用。
     * Buffer 只在同步原生调用期间借用，方法不会保留悬空数据指针。
     * existingLimit 保持用途的小额度，不与新正文长度合并。
     * 原生发布后的 COMMIT_UNCONFIRMED 经 boundary 原样保留。
     * 文件刷新和父目录刷新都是成功返回的必要前提。
     */
    Napi::Value replace(const Napi::CallbackInfo& info) {
        return boundary(info.Env(), [&]() -> Napi::Value {
            require(info.Length() == 4 && info[2].IsBuffer(), "directory.replace.arguments");
            const auto bytes = info[2].As<Napi::Buffer<uint8_t>>();
            value_->replace(text(info[0]), text(info[1]), bytes.Data(), bytes.Length(),
                limit(info[3], maximumBytes));
            return info.Env().Undefined();
        });
    }
    /** 删除包装只接收名字和现有成员额度，原生在持有目录内核同名 inode 后退休并刷新父目录；真实缺失保留 ENOENT 交业务层幂等处理，权限、类型或发布后刷新错误不会被转换为空结果。
     * limit 先核范围再进入元数据判断，不能用负数绕过大小边界。
     * 方法不递归、不支持通配符，也没有按路径降级分支。
     * 返回 undefined 要求底层全部必要操作成功。
     * 退休不等同于物理介质秘密擦除。
     */
    Napi::Value remove(const Napi::CallbackInfo& info) {
        return boundary(info.Env(), [&]() -> Napi::Value {
            require(info.Length() == 2, "directory.remove.arguments");
            value_->remove(text(info[0]), limit(info[1], maximumBytes));
            return info.Env().Undefined();
        });
    }
    /** 目录 close 拒绝参数且只撤销当前授权锚点，已经交付的普通 File 仍由自己的对象负责关闭；重复操作不重新解析原目录路径，因此旧名字被替换之后也不会获得另一个目录的新权限。
     * 关闭错误原样经过统一边界，调用者 finally 可以实际观察失败。
     * 目录历史成员不会因释放句柄被清理。
     * 该方法不终止 CLI，也不生成受控停止证明。
     */
    Napi::Value close(const Napi::CallbackInfo& info) {
        return boundary(info.Env(), [&]() -> Napi::Value {
            require(info.Length() == 0, "directory.close.arguments");
            value_->close();
            return info.Env().Undefined();
        });
    }
    /** 目录类只注册有限成员操作与明确关闭方法，模块导出的打开函数才可创建授权实例；不暴露底层目录数字、通用 POSIX 分派或任意路径访问，业务用途仍由正式 TS 消费者限制。
     * 方法名单固定，测试目标在模块层另加故障函数而不修改此类能力。
     * 原生成员读写始终锚定同一目录 inode。
     * 构造令牌检查同时适用于反射获得的类函数。
     */
    static Napi::Function define(Napi::Env env) {
        return DefineClass(env, "PrivateDirectory", {
            InstanceMethod("read", &DirectoryWrap::read), InstanceMethod("entries", &DirectoryWrap::entries),
            InstanceMethod("createExclusive", &DirectoryWrap::createExclusive),
            InstanceMethod("replace", &DirectoryWrap::replace), InstanceMethod("remove", &DirectoryWrap::remove),
            InstanceMethod("close", &DirectoryWrap::close),
        });
    }
};

/** 模块入口只创建当前环境的类引用并导出目录打开函数，生产目标没有任意描述符采用、调度开关或测试导出；每次打开都重新执行真实目录链校验，缺少公开 POSIX 能力时不回退 JavaScript 路径访问。
 * 构建目标要求 Node-API 九，两个架构各自编译并加载本架构 Mach-O。
 * 初始化函数不探测 Chrome、Keychain 或执行就绪，也不改变任何平台门。
 */
Napi::Object initialize(Napi::Env env, Napi::Object exports) {
    /** 当前模块自己的构造引用由环境清理钩子统一释放，避免生产和独立测试 addon 同时加载时相互覆盖 Node 环境实例数据；打开函数携带自己的指针，目录对象另保留 File 构造强引用。
     * Worker 在独立环境初始化自己的引用，不跨环境使用 napi_value。
     * cleanup 在环境销毁前执行，FunctionReference 不会延迟到进程静态析构。
     * 导出函数只保存固定实现状态，不读取配置路径或环境故障开关。
     * Directory 转移令牌仍由带终结器的 External 托管异常资源。
     * 原生目录打开发生在构造包装之前，失败时不会返回空能力对象。
     * 构造引用清理只影响模块元数据，不生成文件提交成功事实。
     */
    auto* constructors = new Constructors();
    env.AddCleanupHook([](Constructors* owned) { delete owned; }, constructors);
    constructors->file = Napi::Persistent(FileWrap::define(env));
    constructors->directory = Napi::Persistent(DirectoryWrap::define(env));
    exports.Set("openPrivateDirectory", Napi::Function::New(env,
        [](const Napi::CallbackInfo& info) -> Napi::Value {
            return boundary(info.Env(), [&]() -> Napi::Value {
                require(info.Length() == 2 && info[1].IsBoolean(), "directory.open.arguments");
                auto* constructors = static_cast<Constructors*>(info.Data());
                auto* transfer = new Transfer<Directory>(Directory::open(text(info[0]), info[1].As<Napi::Boolean>().Value()));
                auto token = Napi::External<Transfer<Directory>>::New(info.Env(), transfer,
                    [](Napi::Env, Transfer<Directory>* owned) { delete owned; });
                return constructors->directory.New({token, constructors->file.Value()});
            });
        }, "openPrivateDirectory", constructors));
    return exports;
}
}
#ifndef VERIQ_DARWIN_PRIVATE_TESTS
Napi::Object initializePrivateFiles(Napi::Env env, Napi::Object exports) {
    return veriq::darwin::initialize(env, exports);
}
NODE_API_MODULE(veriq_private_files, initializePrivateFiles)
#endif
