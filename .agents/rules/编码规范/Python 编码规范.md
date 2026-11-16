# Python 编码规范

- 来源：[https://google.github.io/styleguide/pyguide.html](https://google.github.io/styleguide/pyguide.html)
- 改编：代码缩进保持原文 4 空格；docstring 悬挂缩进收紧为仅允许 4 空格；禁止 Tab
- 用途：约束 AI/人工编写 Python

> **改编说明**：Google Python Style Guide 原文已要求代码块使用 **4 个空格**缩进、禁止 Tab。本文件保持该要求；文档字符串悬挂缩进统一为 **4 个空格**（原文允许 2 或 4，此处收紧为仅 4）。示例中「禁止 2 空格悬挂缩进」的反例予以保留。

## 1 背景

Python 是 Google 使用的主要动态语言。本风格指南列出了 Python 程序的各种「应当做」与「不应当做」。

为帮助正确格式化代码，我们为 Vim 提供了配置文件。对 Emacs 而言，默认设置通常即可。

许多团队使用 Black 或 Pyink 自动格式化工具，以避免在格式问题上争论。

## 2 Python 语言规则

### 2.1 Lint

使用此 pylintrc，对代码运行 `pylint`。

#### 2.1.1 定义

`pylint` 是用于在 Python 源码中查找缺陷与风格问题的工具。它能发现在 C、C++ 等动态性较弱语言中通常由编译器捕获的问题。由于 Python 的动态特性，部分警告可能不正确；不过误报应当相当少见。

#### 2.1.2 优点

能捕获容易遗漏的错误，如拼写错误、使用未赋值变量等。

#### 2.1.3 缺点

`pylint` 并不完美。为发挥其作用，有时我们需要绕过它、抑制其警告，或修复它。

#### 2.1.4 决定

务必对代码运行 `pylint`。

若警告不合适，应当抑制它们，以免掩盖其他问题。可通过行级注释抑制警告：

```
def do_PUT(self):  # WSGI name, so pylint: disable=invalid-name
    ...

```

每条 `pylint` 警告都有符号名（如 `empty-docstring`）。Google 特有警告以 `g-` 开头。

若仅凭符号名无法清楚看出抑制原因，应补充说明。

这种抑制方式的优点是便于搜索并事后复查。

可通过以下命令获取 `pylint` 警告列表：

```
pylint --list-msgs

```

要获取某条消息的更多信息，使用：

```
pylint --help-msg=invalid-name

```

优先使用 `pylint: disable`，而非已弃用的旧形式 `pylint: disable-msg`。

未使用参数的警告可通过在函数开头删除这些变量来抑制。务必附上注释说明删除原因。「Unused.」即可。例如：

```
def viking_cafe_order(spam: str, beans: str, eggs: str | None = None) -> str:
    del beans, eggs  # Unused by vikings.
    return spam + spam + spam

```

其他常见抑制方式包括：用「`_`」作为未使用参数的标识符、将参数名加「`unused_`」前缀，或赋值给「`_`」。这些写法仍允许，但不再鼓励。它们会破坏按名称传参的调用方，也无法强制保证参数确实未被使用。

### 2.2 导入

仅对包与模块使用 `import` 语句，不要对单独的类型、类或函数使用。

#### 2.2.1 定义

在模块之间共享代码的可复用机制。

#### 2.2.2 优点

命名空间管理约定简单。每个标识符的来源以一致方式标明；`x.Obj` 表示对象 `Obj` 定义在模块 `x` 中。

#### 2.2.3 缺点

模块名仍可能冲突。部分模块名过长不便使用。

#### 2.2.4 决定

- 导入包与模块时使用 `import x`。
- 当 `x` 为包前缀、`y` 为无前缀的模块名时，使用 `from x import y`。
- 在下列任一情形下使用 `from x import y as z`：
- 需要导入两个名为 `y` 的模块。
- `y` 与当前模块中的顶层名称冲突。
- `y` 与作为公共 API 一部分的常见参数名冲突（例如 `features`）。
- `y` 名称过长不便使用。
- 在你的代码语境中 `y` 过于泛化（例如 `from storage.file_system import options as fs_options`）。
- 仅当 `z` 为标准缩写时才使用 `import y as z`（例如 `import numpy as np`）。

例如，模块 `sound.effects.echo` 可以这样导入：

```
from sound.effects import echo
...
echo.EchoFilter(input, output, delay=0.7, atten=4)

```

不要在导入中使用相对名称。即使模块在同一包内，也要使用完整包名。这有助于防止无意中将同一包导入两次。

##### 2.2.4.1 豁免

下列用于支持静态分析与类型检查的模块中的符号豁免于本规则：

- `typing` 模块
- `collections.abc` 模块
- `typing_extensions` 模块



### 2.3 包

使用模块的完整路径位置导入每个模块。

#### 2.3.1 优点

避免因模块搜索路径与作者预期不符而导致的模块名冲突或错误导入。更容易找到模块。

#### 2.3.2 缺点

部署时需要复制包层次结构，因而更难部署。对现代部署机制而言这已不是真正问题。

#### 2.3.3 决定

所有新代码都应当按完整包名导入每个模块。

导入应当如下：

```
Yes:
    # Reference absl.flags in code with the complete name (verbose).
    import absl.flags
    from doctor.who import jodie

    _FOO = absl.flags.DEFINE_string(...)

```

```
Yes:
    # Reference flags in code with just the module name (common).
    from absl import flags
    from doctor.who import jodie

    _FOO = flags.DEFINE_string(...)

```

（假设本文件位于 `doctor/who/`，且同目录存在 `jodie.py`）

```
No:
    # Unclear what module the author wanted and what will be imported.  The actual
    # import behavior depends on external factors controlling sys.path.
    # Which possible jodie module did the author intend to import?
    import jodie

```

尽管某些环境会把主二进制所在目录放进 `sys.path`，也不应假定如此。因此，代码应当假定 `import jodie` 指的是名为 `jodie` 的第三方或顶层包，而非本地的 `jodie.py`。

### 2.4 异常

允许使用异常，但必须谨慎使用。

#### 2.4.1 定义

异常是一种跳出正常控制流以处理错误或其他异常情况的手段。

#### 2.4.2 优点

正常业务代码的控制流不会被错误处理代码打乱。当出现特定条件时，也允许控制流跳过多个栈帧，例如一步从 N 层嵌套函数返回，而不必层层传递错误码。

#### 2.4.3 缺点

可能导致控制流令人困惑。在调用库时容易遗漏错误情况。

#### 2.4.4 决定

异常必须满足以下条件：

- 在合理时使用内置异常类。例如，在验证函数参数等违反前置条件的编程错误时，抛出 `ValueError`。
- 不要用 `assert` 语句代替条件判断或验证前置条件。它们不得成为应用逻辑的关键环节。一个试金石是：去掉 `assert` 后代码仍应能正确工作。`assert` 条件不保证会被求值。基于 pytest 的测试中，用 `assert` 验证期望是可以且预期的。例如：

```
Yes:
    def connect_to_next_port(self, minimum: int) -> int:
        """Connects to the next available port.

        Args:
            minimum: A port value greater or equal to 1024.

        Returns:
            The new minimum port.

        Raises:
            ConnectionError: If no available port is found.
        """
        if minimum < 1024:
            # Note that this raising of ValueError is not mentioned in the doc
            # string's "Raises:" section because it is not appropriate to
            # guarantee this specific behavioral reaction to API misuse.
            raise ValueError(f'Min. port must be at least 1024, not {minimum}.')
        port = self._find_next_open_port(minimum)
        if port is None:
            raise ConnectionError(
                    f'Could not connect to service on port {minimum} or higher.')
        # The code does not depend on the result of this assert.
        assert port >= minimum, (
                f'Unexpected port {port} when minimum was {minimum}.')
        return port

```

```
No:
    def connect_to_next_port(self, minimum: int) -> int:
        """Connects to the next available port.

        Args:
            minimum: A port value greater or equal to 1024.

        Returns:
            The new minimum port.
        """
        assert minimum >= 1024, 'Minimum port must be at least 1024.'
        # The following code depends on the previous assert.
        port = self._find_next_open_port(minimum)
        assert port is not None
        # The type checking of the return statement relies on the assert.
        return port

```

- 库或包可以定义自己的异常。定义时必须继承已有异常类。异常名应当以 `Error` 结尾，且不应造成重复（如 `foo.FooError`）。
- 永远不要使用捕获一切的 `except:`，也不要捕获 `Exception` 或 `StandardError`，除非你是在：
- 重新抛出该异常，或
- 在程序中创建一个隔离点，异常不再向上传播，而是被记录并抑制，例如在线程最外层保护以免崩溃。

Python 在这方面非常宽容，`except:` 会真正捕获一切，包括拼写错误的名称、`sys.exit()` 调用、Ctrl+C 中断、unittest 失败，以及你根本不想捕获的各类其他异常。

- 尽量减少 `try`/`except` 块中的代码量。`try` 体越大，越可能由你未预期会抛异常的那一行抛出异常。此时 `try`/`except` 会掩盖真正错误。
- 使用 `finally` 子句执行无论 `try` 块是否抛异常都要运行的代码。这常用于清理，例如关闭文件。



### 2.5 可变全局状态

避免可变全局状态。

#### 2.5.1 定义

在程序执行期间可能被修改的模块级值或类属性。

#### 2.5.2 优点

偶尔有用。

#### 2.5.3 缺点

- 破坏封装：此类设计可能使正当目标难以实现。例如，若用全局状态管理数据库连接，则同时连接两个不同数据库（如迁移时计算差异）会变得困难。全局注册表也容易出现类似问题。
- 可能在导入期间改变模块行为，因为对全局变量的赋值发生在模块首次导入时。



#### 2.5.4 决定

避免可变全局状态。

在确有必要使用全局状态的罕见情况下，可变全局实体应当在模块级或作为类属性声明，并通过在名称前加 `_` 使其成为内部的。如有必要，对可变全局状态的外部访问必须通过公共函数或类方法完成。参见下文「命名」。请在注释或注释所链接的文档中说明为何使用可变全局状态。

允许并鼓励使用模块级常量。例如：内部常量 `_MAX_HOLY_HANDGRENADE_COUNT = 3`，或公共 API 常量 `SIR_LANCELOTS_FAVORITE_COLOR = "blue"`。常量必须使用全大写加下划线命名。参见下文「命名」。

### 2.6 嵌套/局部/内部类与函数

当用于封闭（close over）局部变量时，嵌套局部函数或类是可以的。内部类是可以的。

#### 2.6.1 定义

类可以定义在方法、函数或类内部。函数可以定义在方法或函数内部。嵌套函数对封闭作用域中定义的变量具有只读访问。

#### 2.6.2 优点

允许定义仅在非常有限作用域内使用的工具类与函数。很有 ADT 风格。常用于实现装饰器。

#### 2.6.3 缺点

嵌套函数与类无法直接测试。嵌套可能使外层函数更长、更难读。

#### 2.6.4 决定

在有所保留的前提下可以使用。除非是在封闭除 `self` 或 `cls` 之外的局部值，否则避免嵌套函数或类。不要仅为了对模块用户隐藏函数而嵌套它。相反，在模块级为其名称加 `_` 前缀，以便测试仍可访问。

### 2.7 推导式与生成器表达式

简单情形下可以使用。

#### 2.7.1 定义

列表、字典与集合推导式以及生成器表达式，提供了简洁高效的方式来创建容器类型与迭代器，而无需求助于传统循环、`map()`、`filter()` 或 `lambda`。

#### 2.7.2 优点

简单的推导式可能比其他字典、列表或集合创建方式更清晰、更简单。生成器表达式可以非常高效，因为它们完全避免创建列表。

#### 2.7.3 缺点

复杂的推导式或生成器表达式可能难读。

#### 2.7.4 决定

允许使用推导式，但不允许多个 `for` 子句或过滤表达式。优化可读性，而非简洁性。

```
Yes:
    result = [mapping_expr for value in iterable if filter_expr]

    result = [
        is_valid(metric={'key': value})
        for value in interesting_iterable
        if a_longer_filter_expression(value)
    ]

    descriptive_name = [
        transform({'key': key, 'value': value}, color='black')
        for key, value in generate_iterable(some_input)
        if complicated_condition_is_met(key, value)
    ]

    result = []
    for x in range(10):
        for y in range(5):
        if x * y > 10:
                result.append((x, y))

    return {
        x: complicated_transform(x)
        for x in long_generator_function(parameter)
        if x is not None
    }

    return (x**2 for x in range(10))

    unique_names = {user.name for user in users if user is not None}

```

```
No:
    result = [(x, y) for x in range(10) for y in range(5) if x * y > 10]

    return (
        (x, y, z)
        for x in range(5)
        for y in range(5)
        if x != y
        for z in range(5)
        if y != z
    )

```



### 2.8 默认迭代器与运算符

对支持默认迭代器与运算符的类型（如列表、字典与文件）使用它们。

#### 2.8.1 定义

字典与列表等容器类型定义了默认迭代器以及成员测试运算符（「in」与「not in」）。

#### 2.8.2 优点

默认迭代器与运算符简单高效。它们直接表达操作，无需额外方法调用。使用默认运算符的函数是通用的，可用于任何支持该操作的类型。

#### 2.8.3 缺点

仅凭方法名无法判断对象类型（除非变量有类型注解）。这也是一种优点。

#### 2.8.4 决定

对支持默认迭代器与运算符的类型（如列表、字典与文件）使用它们。内置类型也定义了迭代器方法。优先使用这些方法，而非返回列表的方法；但你不应当在迭代容器的同时修改该容器。

```
Yes:  for key in adict: ...
      if obj in alist: ...
      for line in afile: ...
      for k, v in adict.items(): ...

```

```
No:   for key in adict.keys(): ...
      for line in afile.readlines(): ...

```



### 2.9 生成器

按需使用生成器。

#### 2.9.1 定义

生成器函数返回一个迭代器，每次执行 yield 语句时产生一个值。产生值后，生成器函数的运行时状态被挂起，直到需要下一个值。

#### 2.9.2 优点

代码更简单，因为每次调用都保留了局部变量与控制流状态。与一次性创建整个值列表的函数相比，生成器占用更少内存。

#### 2.9.3 缺点

生成器中的局部变量在生成器被耗尽或自身被垃圾回收之前不会被垃圾回收。

#### 2.9.4 决定

可以使用。对生成器函数，在文档字符串中使用「Yields:」而非「Returns:」。

若生成器管理昂贵资源，务必强制清理。

一种好的清理方式是用上下文管理器包装生成器，参见 PEP-0533。

### 2.10 Lambda 函数

适合单行使用。优先使用生成器表达式，而非带 `lambda` 的 `map()` 或 `filter()`。

#### 2.10.1 定义

Lambda 在表达式中定义匿名函数，而非在语句中。

#### 2.10.2 优点

方便。

#### 2.10.3 缺点

比局部函数更难阅读与调试。缺少名称意味着栈跟踪更难理解。表达能力受限，因为函数只能包含一个表达式。

#### 2.10.4 决定

允许使用 lambda。若 lambda 内代码跨多行或长于 60–80 字符，最好定义为普通嵌套函数。

对于乘法等常见操作，优先使用 `operator` 模块中的函数，而非 lambda。例如，优先使用 `operator.mul` 而非 `lambda x, y: x * y`。

### 2.11 条件表达式

简单情形下可以使用。

#### 2.11.1 定义

条件表达式（有时称为「三元运算符」）为 if 语句提供更短语法。例如：`x = 1 if cond else 2`。

#### 2.11.2 优点

比 if 语句更短、更方便。

#### 2.11.3 缺点

可能比 if 语句更难读。若表达式很长，条件可能难以定位。

#### 2.11.4 决定

简单情形下可以使用。真值表达式、if 表达式、else 表达式每一部分都必须能放在一行。事情更复杂时使用完整 if 语句。

```
Yes:
    one_line = 'yes' if predicate(value) else 'no'
    slightly_split = ('yes' if predicate(value)
                      else 'no, nein, nyet')
    the_longest_ternary_style_that_can_be_done = (
        'yes, true, affirmative, confirmed, correct'
        if predicate(value)
        else 'no, false, negative, nay')

```

```
No:
    bad_line_breaking = ('yes' if predicate(value) else
                        'no')
    portion_too_long = ('yes'
                        if some_long_module.some_long_predicate_function(
                            really_long_variable_name)
                        else 'no, false, negative, nay')

```



### 2.12 默认参数值

多数情况下可以使用。

#### 2.12.1 定义

可以在函数参数列表末尾为变量指定值，例如 `def foo(a, b=0):`。若调用 `foo` 时只传一个参数，`b` 被设为 0。若传两个参数，`b` 取第二个参数的值。

#### 2.12.2 优点

常常有一个使用大量默认值的函数，但偶尔需要覆盖这些默认值。默认参数值提供了简便方式，而不必为罕见例外定义大量函数。由于 Python 不支持重载方法/函数，默认参数是「伪装」重载行为的简便方式。

#### 2.12.3 缺点

默认参数在模块加载时求值一次。若参数是列表或字典等可变对象，可能造成问题。若函数修改该对象（例如向列表追加项），默认值会被修改。

#### 2.12.4 决定

可以使用，但须注意：

不要在函数或方法定义中使用可变对象作为默认值。

```
Yes: def foo(a, b=None):
         if b is None:
             b = []
Yes: def foo(a, b: Sequence | None = None):
         if b is None:
             b = []
Yes: def foo(a, b: Sequence = ()):  # Empty tuple OK since tuples are immutable.
         ...

```

```
from absl import flags
_FOO = flags.DEFINE_string(...)

No:  def foo(a, b=[]):
         ...
No:  def foo(a, b=time.time()):  # Is `b` supposed to represent when this module was loaded?
         ...
No:  def foo(a, b=_FOO.value):  # sys.argv has not yet been parsed...
         ...
No:  def foo(a, b: Mapping = {}):  # Could still get passed to unchecked code.
         ...

```



### 2.13 属性（Properties）

属性可用于控制需要平凡计算或逻辑的属性获取或设置。属性实现必须符合普通属性访问的一般预期：它们应当廉价、直接且不令人意外。

#### 2.13.1 定义

一种将获取与设置属性的方法调用包装为标准属性访问的方式。

#### 2.13.2 优点

- 允许使用属性访问与赋值 API，而非 getter/setter 方法调用。
- 可用于使属性只读。
- 允许惰性计算。
- 在类内部独立于用户演进时，提供一种维持公共接口的方式。



#### 2.13.3 缺点

- 可能像运算符重载一样隐藏副作用。
- 对子类可能令人困惑。



#### 2.13.4 决定

允许使用属性，但像运算符重载一样，仅在必要时使用，并符合典型属性访问的预期；否则遵循 getter 与 setter 规则。

例如，仅用属性同时获取与设置内部属性是不允许的：没有发生计算，因此属性是多余的（应改为公开该属性）。相比之下，用属性控制属性访问或计算平凡派生值是允许的：逻辑简单且不令人意外。

属性应当用 `@property` 装饰器创建。手动实现属性描述符被视为高级特性。

带属性的继承可能不直观。不要用属性实现子类可能想要覆盖与扩展的计算。

### 2.14 真/假求值

尽可能使用「隐式」假值（有少数注意事项）。

#### 2.14.1 定义

Python 在布尔语境中将某些值求值为 `False`。一条快速「经验法则」是：所有「空」值都被视为假，因此 `0, None, [], {}, ''` 在布尔语境中都求值为假。

#### 2.14.2 优点

使用 Python 布尔值的条件更易读、更不易出错。多数情况下也更快。

#### 2.14.3 缺点

对 C/C++ 开发者可能看起来奇怪。

#### 2.14.4 决定

尽可能使用「隐式」假值，例如用 `if foo:` 而非 `if foo != []:`。但有几条注意事项应当牢记：

- 检查 `None` 值时始终使用 `if foo is None:`（或 `is not None`）。例如，测试默认为 `None` 的变量或参数是否被设为其他值时。该其他值可能在布尔语境中为假！
- 永远不要用 `==` 将布尔变量与 `False` 比较。改用 `if not x:`。若需要区分 `False` 与 `None`，则串联表达式，例如 `if not x and x is not None:`。
- 对序列（字符串、列表、元组），利用空序列为假这一事实，因此 `if seq:` 与 `if not seq:` 分别优于 `if len(seq):` 与 `if not len(seq):`。
- 处理整数时，隐式假值可能风险大于收益（即意外把 `None` 当作 0）。你可以将已知为整数（且不是 `len()` 的结果）的值与整数 0 比较。

```
Yes: if not users:
         print('no users')

     if i % 10 == 0:
         self.handle_multiple_of_ten()

     def f(x=None):
         if x is None:
             x = []

```

```
No:  if len(users) == 0:
         print('no users')

     if not i % 10:
         self.handle_multiple_of_ten()

     def f(x=None):
         x = x or []

```

- 注意 `'0'`（即作为字符串的 `0`）求值为真。
- 注意 Numpy 数组在隐式布尔语境中可能抛异常。测试 `np.array` 是否为空时优先使用 `.size` 属性（例如 `if not users.size`）。



### 2.16 词法作用域

可以使用。

#### 2.16.1 定义

嵌套的 Python 函数可以引用封闭函数中定义的变量，但不能对其赋值。变量绑定通过词法作用域解析，即基于静态程序文本。块中对某名称的任何赋值都会使 Python 将该名称的所有引用视为局部变量，即使使用出现在赋值之前。若出现 global 声明，则该名称被视为全局变量。

此特性的使用示例如下：

```
def get_adder(summand1: float) -> Callable[[float], float]:
    """Returns a function that adds numbers to a given number."""
    def adder(summand2: float) -> float:
        return summand1 + summand2

    return adder

```



#### 2.16.2 优点

常常带来更清晰、更优雅的代码。对有经验的 Lisp 与 Scheme（以及 Haskell、ML……）程序员尤其舒心。

#### 2.16.3 缺点

可能导致令人困惑的缺陷，例如这个基于 PEP-0227 的例子：

```
i = 4
def foo(x: Iterable[int]):
    def bar():
        print(i, end='')
    # ...
    # A bunch of code here
    # ...
    for i in x:  # Ah, i *is* local to foo, so this is what bar sees
        print(i, end='')
    bar()

```

因此 `foo([1, 2, 3])` 会打印 `1 2 3 3`，而非 `1 2 3 4`。

#### 2.16.4 决定

可以使用。

### 2.17 函数与方法装饰器

在有明显优势时审慎使用装饰器。避免 `staticmethod`，并限制 `classmethod` 的使用。

#### 2.17.1 定义

函数与方法的装饰器（亦即「`@` 记号」）。一个常见装饰器是 `@property`，用于将普通方法转换为动态计算的属性。不过，装饰器语法也允许用户定义装饰器。具体而言，对某个函数 `my_decorator`，下面这段：

```
class C:
    @my_decorator
    def method(self):
        # method body ...

```

等价于：

```
class C:
    def method(self):
        # method body ...
    method = my_decorator(method)

```



#### 2.17.2 优点

优雅地指定对方法的某种变换；该变换可能消除重复代码、强制不变量等。

#### 2.17.3 缺点

装饰器可对函数的参数或返回值执行任意操作，导致令人意外的隐式行为。此外，装饰器在对象定义时执行。对模块级对象（类、模块函数……），这发生在导入时。装饰器代码中的失败几乎无法恢复。

#### 2.17.4 决定

在有明显优势时审慎使用装饰器。装饰器应当遵循与函数相同的导入与命名指南。装饰器的文档字符串应当清楚声明该函数是装饰器。为装饰器编写单元测试。

避免在装饰器本身中产生外部依赖（例如不要依赖文件、套接字、数据库连接等），因为装饰器运行时它们可能不可用（在导入时，或许来自 `pydoc` 或其他工具）。以有效参数调用的装饰器应当（尽可能）保证在所有情况下都能成功。

装饰器是「顶层代码」的特例——更多讨论见 main。

除非为了与现有库中定义的 API 集成而被迫使用，否则永远不要使用 `staticmethod`。改为编写模块级函数。

仅在编写命名构造器，或修改必要全局状态（如进程级缓存）的类专用例程时使用 `classmethod`。

### 2.18 线程

不要依赖内置类型的原子性。

尽管 Python 的字典等内置数据类型看似具有原子操作，但在边角情况下它们并非原子（例如若 `__hash__` 或 `__eq__` 实现为 Python 方法），不应当依赖其原子性。也不应当依赖原子变量赋值（因为这反过来又依赖字典）。

优先使用 `queue` 模块的 `Queue` 数据类型在线程间传递数据。否则，使用 `threading` 模块及其锁原语。优先使用条件变量与 `threading.Condition`，而非更底层的锁。

### 2.19 高级特性

避免这些特性。

#### 2.19.1 定义

Python 是极其灵活的语言，提供许多花哨特性，如自定义元类、访问字节码、即时编译、动态继承、对象改父、导入黑科技、反射（例如某些对 `getattr()` 的使用）、修改系统内部、实现定制清理的 `__del__` 方法等。

#### 2.19.2 优点

这些是强大的语言特性。它们可以使代码更紧凑。

#### 2.19.3 缺点

在并非绝对必要时使用这些「酷」特性很诱人。使用非常规底层特性的代码更难阅读、理解与调试。起初（对原作者）似乎并非如此，但重访代码时，往往比更长但直截了当的代码更困难。

#### 2.19.4 决定

在代码中避免这些特性。

内部使用这些特性的标准库模块与类可以使用（例如 `abc.ABCMeta`、`dataclasses` 与 `enum`）。

### 2.20 现代 Python：from **future** 导入

新语言版本的语义变更可能被门控在特殊的 future 导入之后，以便在更早运行时按文件启用。

#### 2.20.1 定义

能够通过 `from __future__ import` 语句开启部分更现代特性，允许在预期未来 Python 版本到来前尽早使用这些特性。

#### 2.20.2 优点

实践证明这能使运行时版本升级更平滑，因为可以在按文件声明兼容性的同时进行变更，并防止这些文件内的回归。现代代码更易维护，因其不太可能积累在未来运行时升级时成问题的技术债。

#### 2.20.3 缺点

此类代码可能无法在引入所需 future 语句之前的极旧解释器版本上运行。在支持极其广泛环境的项目中，这种需求更常见。

#### 2.20.4 决定



##### from **future** 导入

鼓励使用 `from __future__ import` 语句。它允许给定源文件今天就开始使用更现代的 Python 语法特性。一旦不再需要在仍把特性藏在 `__future__` 导入之后的版本上运行，可随时删除这些行。

在可能在旧至 3.5 而非 >= 3.7 的版本上执行的代码中，导入：

```
from __future__ import generator_stop

```

更多信息请阅读 Python future 语句定义文档。

在确信代码只会在足够现代的环境中使用之前，请不要删除这些导入。即使你今天并未在代码中使用某个 future 导入启用的特性，保留它也能防止后续修改无意依赖旧行为。

按需使用其他 `from __future__` 导入语句。

### 2.21 类型注解代码

可以用类型提示为 Python 代码做注解。在构建时用 pyrefly 等类型检查工具检查代码。多数情况下，可行时类型注解写在源文件中。对第三方或扩展模块，注解可以写在桩文件 `.pyi` 中。

#### 2.21.1 定义

类型注解（或「类型提示」）用于函数或方法的参数与返回值：

```
def func(a: int) -> list[int]:

```

也可以用类似语法声明变量类型：

```
a: SomeType = some_func()

```



#### 2.21.2 优点

类型注解提升代码可读性与可维护性。类型检查器会将许多运行时错误转化为构建时错误，并降低使用高级特性的能力。

#### 2.21.3 缺点

你必须保持类型声明最新。你可能看到你认为是合法代码的类型错误。使用类型检查器可能降低使用高级特性的能力。

#### 2.21.4 决定

强烈鼓励在更新代码时启用 Python 类型分析。在添加或修改公共 API 时，包含类型注解并在构建系统中启用类型检查。由于静态分析对 Python 相对较新，我们承认不良副作用（如错误推断的类型）可能阻碍部分项目采用。在这些情况下，鼓励作者在 BUILD 文件或代码中（视情况）添加带 TODO 的注释或指向描述当前阻碍类型注解采用之问题的缺陷链接。

## 3 Python 风格规则



### 3.1 分号

不要用分号结束行，也不要用分号把两条语句放在同一行。

### 3.2 行长度

最大行长度为 80 个字符。

对 80 字符限制的明确例外：

- 长导入语句。
- 注释中的 URL、路径名或长标志。
- 不含空白、不便拆成多行的长字符串模块级常量，例如 URL 或路径名。
- Pylint 禁用注释。（例如：`# pylint: disable=invalid-name`）

不要用反斜杠做显式续行。

相反，利用 Python 在圆括号、方括号与花括号内的隐式行拼接。必要时，可在表达式外再加一对圆括号。

注意本规则并不禁止字符串内的反斜杠转义换行（见下文）。

```
Yes: foo_bar(self, width, height, color='black', design=None, x='foo',
             emphasis=None, highlight=0)

```

```

Yes: if (width == 0 and height == 0 and
         color == 'red' and emphasis == 'strong'):

     (bridge_questions.clarification_on
      .average_airspeed_of.unladen_swallow) = 'African or European?'

     with (
         very_long_first_expression_function() as spam,
         very_long_second_expression_function() as beans,
         third_thing() as eggs,
     ):
       place_order(eggs, beans, spam, beans)

```

```

No:  if width == 0 and height == 0 and \
         color == 'red' and emphasis == 'strong':

     bridge_questions.clarification_on \
         .average_airspeed_of.unladen_swallow = 'African or European?'

     with very_long_first_expression_function() as spam, \
           very_long_second_expression_function() as beans, \
           third_thing() as eggs:
       place_order(eggs, beans, spam, beans)

```

当字面字符串无法放在单行时，用圆括号做隐式行拼接。

```
x = ('This will build a very long long '
     'long long long long long long string')

```

优先在尽可能高的语法层级断行。若必须断行两次，两次都应在同一语法层级断开。

```
Yes: bridgekeeper.answer(
         name="Arthur", quest=questlib.find(owner="Arthur", perilous=True))

     answer = (a_long_line().of_chained_methods()
               .that_eventually_provides().an_answer())

     if (
         config is None
         or 'editor.language' not in config
         or config['editor.language'].use_spaces is False
     ):
       use_tabs()

```

```
No: bridgekeeper.answer(name="Arthur", quest=questlib.find(
                owner="Arthur", perilous=True))

        answer = a_long_line().of_chained_methods().that_eventually_provides(
                ).an_answer()

        if (config is None or 'editor.language' not in config or config[
                'editor.language'].use_spaces is False):
            use_tabs()

```

在注释中，必要时将长 URL 单独成行。

```
Yes:  # See details at
      # http://www.example.com/us/developer/documentation/api/content/v2.0/csv_file_name_extension_full_specification.html

```

```
No:  # See details at
     # http://www.example.com/us/developer/documentation/api/content/\
     # v2.0/csv_file_name_extension_full_specification.html

```

注意上文续行示例中元素的缩进；解释见缩进一节。

文档字符串摘要行必须保持在 80 字符限制内。

在所有其他情况下，若一行超过 80 字符，且 Black 或 Pyink 自动格式化工具无法将该行压到限制以下，则允许该行超过此最大值。在合理时，鼓励作者按上述说明手动断行。

### 3.3 圆括号

节约使用圆括号。

在元组周围使用圆括号是可以的，但不是必需的。除非为了隐式续行或标明元组，否则不要在 return 语句或条件语句中使用它们。

```
Yes: if foo:
         bar()
     while x:
         x = bar()
     if x and y:
         bar()
     if not x:
         bar()
     # For a 1 item tuple the ()s are more visually obvious than the comma.
     onesie = (foo,)
     return foo
     return spam, beans
     return (spam, beans)
     for (x, y) in dict.items(): ...

```

```
No:  if (x):
         bar()
     if not(x):
         bar()
     return (foo)

```



### 3.4 缩进

用 4 个空格缩进代码块。

永远不要使用 Tab。隐式续行应当垂直对齐被换行的元素（见行长度示例），或使用 4 个空格的悬挂缩进。闭合的（圆、方或花）括号可以放在表达式末尾，或单独成行，但单独成行时应当与对应开括号所在行缩进相同。

```
Yes:   # Aligned with opening delimiter.
       foo = long_function_name(var_one, var_two,
                                var_three, var_four)
       meal = (spam,
               beans)

       # Aligned with opening delimiter in a dictionary.
       foo = {
           'long_dictionary_key': value1 +
                                  value2,
           ...
       }

       # 4-space hanging indent; nothing on first line.
       foo = long_function_name(
           var_one, var_two, var_three,
           var_four)
       meal = (
           spam,
           beans)

       # 4-space hanging indent; nothing on first line,
       # closing parenthesis on a new line.
       foo = long_function_name(
           var_one, var_two, var_three,
           var_four
       )
       meal = (
           spam,
           beans,
       )

       # 4-space hanging indent in a dictionary.
       foo = {
           'long_dictionary_key':
               long_dictionary_value,
           ...
       }

```

```
No:    # Stuff on first line forbidden.
       foo = long_function_name(var_one, var_two,
           var_three, var_four)
       meal = (spam,
           beans)

       # 2-space hanging indent forbidden.
       foo = long_function_name(
         var_one, var_two, var_three,
         var_four)

       # No hanging indent in a dictionary.
       foo = {
           'long_dictionary_key':
           long_dictionary_value,
           ...
       }

```



#### 3.4.1 条目序列中的尾随逗号？

仅当闭合容器记号 `]`、`)` 或 `}` 与最后一个元素不在同一行时，以及单元素元组时，才推荐在条目序列中使用尾随逗号。尾随逗号的存在也被我们的 Python 代码自动格式化工具 Black 或 Pyink 用作提示：当最终元素后存在 `,` 时，将其格式化为每行一项。

```
Yes:   golomb3 = [0, 1, 3]
       golomb4 = [
           0,
           1,
           4,
           6,
       ]

```

```
No:    golomb4 = [
           0,
           1,
           4,
           6,]

```



### 3.5 空行

顶层定义（无论函数还是类定义）之间空两行。方法定义之间，以及 `class` 的文档字符串与第一个方法之间空一行。`def` 行后不要空行。在函数或方法内部按你的判断适当使用单个空行。

空行不必锚定在定义上。例如，紧挨在函数、类与方法定义之前的相关注释可能合理。考虑你的注释是否作为文档字符串的一部分更有用。

### 3.6 空白

标点周围的空格遵循标准排印规则。

圆括号、方括号或花括号内部不要有空白。

```
Yes: spam(ham[1], {'eggs': 2}, [])

```

```
No:  spam( ham[ 1 ], { 'eggs': 2 }, [ ] )

```

逗号、分号或冒号之前不要有空白。逗号、分号或冒号之后要有空白，行末除外。

```
Yes: if x == 4:
         print(x, y)
     x, y = y, x

```

```
No:  if x == 4 :
         print(x , y)
     x , y = y , x

```

开始参数列表、索引或切片的开括号/方括号之前不要有空白。

```
Yes: spam(1)

```

```
No:  spam (1)

```

```
Yes: dict['key'] = list[index]

```

```
No:  dict ['key'] = list [index]

```

不要有尾随空白。

赋值（`=`）、比较（`==, <, >, !=, <>, <=, >=, in, not in, is, is not`）与布尔运算（`and, or, not`）两侧各用一个空格。算术运算符（`+`、`-`、`*`、`/`、`//`、`%`、`**`、`@`）周围是否插入空格凭更好的判断。

```
Yes: x == 1

```

```
No:  x<1

```

传递关键字参数或定义默认参数值时，永远不要在 `=` 周围使用空格，有一个例外：存在类型注解时，默认参数值的 `=` 周围要使用空格。

```
Yes: def complex(real, imag=0.0): return Magic(r=real, i=imag)
Yes: def complex(real, imag: float = 0.0): return Magic(r=real, i=imag)

```

```
No:  def complex(real, imag = 0.0): return Magic(r = real, i = imag)
No:  def complex(real, imag: float=0.0): return Magic(r = real, i = imag)

```

不要用空格在连续行上垂直对齐记号，因为这会成为维护负担（适用于 `:`、`#`、`=` 等）：

```
Yes:
    foo = 1000  # comment
    long_name = 2  # comment that should not be aligned

    dictionary = {
        'foo': 1,
            'long_name': 2,
    }

```

```
No:
    foo       = 1000  # comment
    long_name = 2     # comment that should not be aligned

    dictionary = {
        'foo'      : 1,
            'long_name': 2,
    }

```



### 3.7 Shebang 行

多数 `.py` 文件不需要以 `#!` 行开头。程序的主文件以 `#!/usr/bin/env python3`（以支持虚拟环境）或按 PEP-394 使用 `#!/usr/bin/python3` 开头。

该行由内核用于查找 Python 解释器，但导入模块时会被 Python 忽略。仅在打算直接执行的文件上才有必要。

### 3.8 注释与文档字符串

务必对模块、函数、方法文档字符串与行内注释使用正确风格。

#### 3.8.1 文档字符串

Python 用文档字符串记录代码。文档字符串是包、模块、类或函数中的第一条语句字符串。这些字符串可通过对象的 `__doc__` 成员自动提取，并由 `pydoc` 使用。（试着对你的模块运行 `pydoc` 看看效果。）文档字符串始终使用三双引号 `"""` 格式（按 PEP 257）。文档字符串应当组织为摘要行（一个物理行，不超过 80 字符），以句号、问号或感叹号结尾。写更多内容时（鼓励），其后必须跟一个空行，再跟文档字符串的其余部分，起始位置与第一行第一个引号相同。下文还有更多文档字符串格式指南。

#### 3.8.2 模块

每个文件都应包含许可证样板。选择项目所用许可证的适当样板（例如 Apache 2.0、BSD、LGPL、GPL）。

文件应当以描述模块内容与用法的文档字符串开头。

```
"""A one-line summary of the module or program, terminated by a period.

Leave one blank line.  The rest of this docstring should contain an
overall description of the module or program.  Optionally, it may also
contain a brief description of exported classes and functions and/or usage
examples.

Typical usage example:

    foo = ClassFoo()
    bar = foo.function_bar()
"""

```



##### 3.8.2.1 测试模块

测试模块不要求模块级文档字符串。`unittest.TestCase` 子类上不要求类文档字符串，`unittest.TestCase` 子类中的 `test_` 方法也不要求方法文档字符串。仅重复类名或方法名的文档字符串应当省略。

当文档字符串提供额外信息时应当包含，例如说明测试应如何运行，或解释异常的 setup 模式或外部依赖。

```
"""This blaze test uses golden files.

You can update those files by running
`blaze run //foo/bar:foo_test -- --update_golden_files` from the `google3`
directory.
"""

```

不提供任何新信息的文档字符串不应当使用。

```
"""Tests for foo.bar."""

```

或

```
    def test_foo_is_barred(self):
        """Tests that bar is applied to foo."""

```



#### 3.8.3 函数与方法

在本节中，「函数」指方法、函数、生成器或属性。

对具有下列一项或多项性质的每个函数，文档字符串是强制的：

- 属于公共 API
- 规模非平凡
- 逻辑不明显

文档字符串应当提供足够信息，使读者无需阅读函数代码即可写出对该函数的调用。文档字符串应当描述函数的调用语法与语义，但一般不描述实现细节，除非这些细节与如何使用该函数相关。例如，作为副作用修改其某个参数的函数应当在文档字符串中注明。否则，与调用方无关、但微妙而重要的实现细节，更适合作为代码旁的注释，而非写在函数文档字符串中。

文档字符串可以是描述性风格（`"""Fetches rows from a Bigtable."""`）或祈使风格（`"""Fetch rows from a Bigtable."""`），但同一文件内风格应当一致。`@property` 数据描述符的文档字符串应当使用与属性或函数参数相同的风格（`"""The Bigtable path."""`，而非 `"""Returns the Bigtable path."""`）。

函数的某些方面应当在下列特殊分节中记录。每个分节以标题行开头，标题以冒号结尾。除标题外的所有分节应保持 **使用 4 个空格悬挂缩进**。当函数名与签名信息量足够、可用一行文档字符串恰当描述时，这些分节可以省略。

Args:
: 按名称列出每个参数。描述应当跟在名称之后，用冒号后跟空格或换行分隔。若描述太长无法放在单个 80 字符行上，相对参数名再 **使用 4 个空格悬挂缩进**。若代码中没有对应类型注解，描述应当包含所需类型。若函数接受 `*foo`（可变长度参数列表）和/或 `**bar`（任意关键字参数），应当将它们列为 `*foo` 与 `**bar`。
Returns:（生成器用 Yields:）
: 描述返回值的语义，包括类型注解未提供的任何类型信息。若函数仅返回 None，则不要求此分节。若文档字符串以「Return」「Returns」「Yield」或「Yields」开头（例如 `"""Returns row from Bigtable as a tuple of strings."""`）且开场句足以描述返回值，也可以省略。不要模仿较旧的「NumPy 风格」（示例），那种风格常把元组返回值写成仿佛有多个各自命名的返回值（从不提及元组）。相反，将此类返回值描述为：「Returns: A tuple (mat_a, mat_b), where mat_a is …, and …」。文档字符串中的辅助名称不必对应函数体中使用的任何内部名称（因为那些不是 API 的一部分）。若函数使用 `yield`（是生成器），`Yields:` 分节应当记录 `next()` 返回的对象，而非调用求值得到的生成器对象本身。
Raises:
: 列出与接口相关的所有异常并附描述。使用与 Args: 中描述的类似「异常名 + 冒号 + 空格或换行及悬挂缩进」风格。你不应当记录在违反文档字符串所规定 API 时抛出的异常（因为这会悖论式地使违反 API 时的行为成为 API 的一部分）。

```
def fetch_smalltable_rows(
    table_handle: smalltable.Table,
    keys: Sequence[bytes | str],
    require_all_keys: bool = False,
) -> Mapping[bytes, tuple[str, ...]]:
    """Fetches rows from a Smalltable.

    Retrieves rows pertaining to the given keys from the Table instance
    represented by table_handle.  String keys will be UTF-8 encoded.

    Args:
        table_handle: An open smalltable.Table instance.
        keys: A sequence of strings representing the key of each table
                row to fetch.  String keys will be UTF-8 encoded.
        require_all_keys: If True only rows with values set for all keys will be
                returned.

    Returns:
        A dict mapping keys to the corresponding table row data
        fetched. Each row is represented as a tuple of strings. For
        example:

        {b'Serak': ('Rigel VII', 'Preparer'),
         b'Zim': ('Irk', 'Invader'),
         b'Lrrr': ('Omicron Persei 8', 'Emperor')}

        Returned keys are always bytes.  If a key from the keys argument is
        missing from the dictionary, then that row was not found in the
        table (and require_all_keys must have been False).

    Raises:
        IOError: An error occurred accessing the smalltable.
    """

```

类似地，这种在 `Args:` 中换行的变体也允许：

```
def fetch_smalltable_rows(
    table_handle: smalltable.Table,
    keys: Sequence[bytes | str],
    require_all_keys: bool = False,
) -> Mapping[bytes, tuple[str, ...]]:
    """Fetches rows from a Smalltable.

    Retrieves rows pertaining to the given keys from the Table instance
    represented by table_handle.  String keys will be UTF-8 encoded.

    Args:
        table_handle:
        An open smalltable.Table instance.
        keys:
        A sequence of strings representing the key of each table row to
        fetch.  String keys will be UTF-8 encoded.
        require_all_keys:
        If True only rows with values set for all keys will be returned.

    Returns:
        A dict mapping keys to the corresponding table row data
        fetched. Each row is represented as a tuple of strings. For
        example:

        {b'Serak': ('Rigel VII', 'Preparer'),
       b'Zim': ('Irk', 'Invader'),
       b'Lrrr': ('Omicron Persei 8', 'Emperor')}

        Returned keys are always bytes.  If a key from the keys argument is
        missing from the dictionary, then that row was not found in the
        table (and require_all_keys must have been False).

    Raises:
        IOError: An error occurred accessing the smalltable.
    """

```

被装饰函数的文档字符串必须说明装饰器应用之后的函数行为，因为那才是调用方将观察到的行为。

```
@contextlib.contextmanager
def read_from_remote_filesystem(url: str) -> Iterator[RemoteFile]:
        """Open a file for reading from a remote filesystem.

        Args:
            url: The address of the remote file.

        Returns:
            A context manager providing a reference to a remote file.
        """
        reader = remote_file_reader(url)
        try:
                yield reader
        finally:
                reader.close()

```



##### 3.8.3.1 覆盖的方法

覆盖基类方法的方法若显式用 `@override` 装饰，则不需要文档字符串，除非覆盖方法的行为实质性细化了基方法的契约，或需要提供细节（例如记录额外副作用），此时覆盖方法上至少需要记录那些差异的文档字符串。

```
from typing import override

class Parent:
    def do_something(self):
        """Parent method, includes docstring."""

# Child class, method annotated with override.
class Child(Parent):
    @override
    def do_something(self):
        pass

```

```
# Child class, but without @override decorator, a docstring is required.
class Child(Parent):
    def do_something(self):
        pass

# Docstring is trivial, @override is sufficient to indicate that docs can be
# found in the base class.
class Child(Parent):
    @override
    def do_something(self):
        """See base class."""

```



#### 3.8.4 类

类应当在类定义下方有描述该类的文档字符串。公共属性（不含 properties）应当在此处的 `Attributes` 分节中记录，并遵循与函数 `Args` 分节相同的格式。

```
class SampleClass:
        """Summary of class here.

        Longer class information...
        Longer class information...

        Attributes:
                likes_spam: A boolean indicating if we like SPAM or not.
                eggs: An integer count of the eggs we have laid.
        """

        def __init__(self, likes_spam: bool = False):
                """Initializes the instance based on spam preference.

                Args:
                    likes_spam: Defines if instance exhibits this preference.
                """
                self.likes_spam = likes_spam
                self.eggs = 0

        @property
        def butter_sticks(self) -> int:
                """The number of butter sticks we have."""

```

所有类文档字符串都应当以描述类实例代表什么的一行摘要开头。这意味着 `Exception` 的子类也应当描述该异常代表什么，而非它可能发生的语境。类文档字符串不应当重复不必要信息，例如该类是一个类。

```
# Yes:
class CheeseShopAddress:
    """The address of a cheese shop.

    ...
    """

class OutOfCheeseError(Exception):
    """No more cheese is available."""

```

```
# No:
class CheeseShopAddress:
    """Class that describes the address of a cheese shop.

    ...
    """

class OutOfCheeseError(Exception):
    """Raised when no more cheese is available."""

```

若类被装饰，其文档字符串必须说明装饰器应用之后的类行为。

#### 3.8.5 块注释与行内注释

最后需要注释的地方是代码中棘手的部分。若你打算在下次代码评审时解释它，现在就应当注释。复杂操作在开始前用几行注释说明。不明显的操作在行末加注释。

```
# We use a weighted dictionary search to find out where i is in
# the array.  We extrapolate position based on the largest num
# in the array and the array size and then do binary search to
# get the exact number.

if i & (i-1) == 0:  # True if i is 0 or a power of 2.

```

为提高易读性，这些注释应当至少距代码 2 个空格，以注释字符 `#` 开头，其后在注释正文前至少再有一个空格。

另一方面，永远不要描述代码本身。假定读代码的人比你更懂 Python（尽管不懂你想做什么）。

```
# BAD COMMENT: Now go through the b array and make sure whenever i occurs
# the next element is i+1

```



#### 3.8.6 标点、拼写与语法

注意标点、拼写与语法；写得好的注释比写得差的更容易读。

注释应当像叙事文本一样可读，带有正确的大小写与标点。许多情况下，完整句子比句子片段更易读。较短注释（如代码行末注释）有时可以不那么正式，但你应当保持风格一致。

尽管被代码评审者指出该用分号却用了逗号可能令人沮丧，但源代码保持高清晰度与可读性非常重要。正确的标点、拼写与语法有助于这一目标。

### 3.10 字符串

即使参数全是字符串，也要使用 f-string、`%` 运算符或 `format` 方法来格式化字符串。用你的最佳判断在字符串格式化选项间抉择。用 `+` 做单次拼接是可以的，但不要用 `+` 做格式化。

```
Yes: x = f'name: {name}; score: {n}'
     x = '%s, %s!' % (imperative, expletive)
     x = '{}, {}'.format(first, second)
     x = 'name: %s; score: %d' % (name, n)
     x = 'name: %(name)s; score: %(score)d' % {'name':name, 'score':n}
     x = 'name: {}; score: {}'.format(name, n)
     x = a + b

```

```
No: x = first + ', ' + second
    x = 'name: ' + name + '; score: ' + str(n)

```

避免在循环内用 `+` 与 `+=` 运算符累积字符串。在某些条件下，用加法累积字符串可能导致二次而非线性运行时间。尽管此类常见累积可能在 CPython 上被优化，那只是实现细节。优化适用的条件不易预测且可能变化。相反，将每个子串加入列表，循环结束后用 `''.join` 连接列表，或将每个子串写入 `io.StringIO` 缓冲区。这些技巧一致具有摊销线性运行时复杂度。

```
Yes: items = ['<table>']
     for last_name, first_name in employee_list:
         items.append('<tr><td>%s, %s</td></tr>' % (last_name, first_name))
     items.append('</table>')
     employee_table = ''.join(items)

```

```
No: employee_table = '<table>'
    for last_name, first_name in employee_list:
        employee_table += '<tr><td>%s, %s</td></tr>' % (last_name, first_name)
    employee_table += '</table>'

```

在文件内对字符串引号字符的选择保持一致。选定 `'` 或 `"` 并坚持使用。为避免在字符串内反斜杠转义引号，对该字符串使用另一种引号是可以的。

```
Yes:
    Python('Why are you hiding your eyes?')
    Gollum("I'm scared of lint errors.")
    Narrator('"Good!" thought a happy Python reviewer.')

```

```
No:
    Python("Why are you hiding your eyes?")
    Gollum('The lint. It burns. It burns us.')
    Gollum("Always the great lint. Watching. Watching.")

```

多行字符串优先使用 `"""` 而非 `'''`。仅当项目对常规字符串也使用 `'` 时，才可以（且仅此条件）对所有非文档字符串的多行字符串选择使用 `'''`。文档字符串无论怎样都必须使用 `"""`。

多行字符串不会随程序其余部分的缩进流动。若需要避免在字符串中嵌入多余空格，使用串联的单行字符串，或带 `textwrap.dedent()` 的多行字符串以去除每行起始空格：

```
No:
      long_string = """This is pretty ugly.
    Don't do this.
    """

```

```
Yes:
    long_string = """This is fine if your use case can accept
            extraneous leading spaces."""

```

```
Yes:
    long_string = ("And this is fine if you cannot accept\n" +
                                "extraneous leading spaces.")

```

```
Yes:
    long_string = ("And this too is fine if you cannot accept\n"
                                "extraneous leading spaces.")

```

```
Yes:
    import textwrap

    long_string = textwrap.dedent("""\
            This is also fine, because textwrap.dedent()
            will collapse common leading spaces in each line.""")

```

注意此处使用反斜杠并不违反禁止显式续行的规定；在这种情况下，反斜杠是在转义字符串字面量中的换行。

#### 3.10.1 日志

对期望模式字符串（带 %-占位符）作为第一个参数的日志函数：始终用字符串字面量（不要用 f-string！）作为第一个参数调用，模式参数作为后续参数。某些日志实现会将未展开的模式字符串收集为可查询字段。这也避免为没有任何日志器配置输出的消息花费渲染时间。

```
Yes:
    import tensorflow as tf
    logger = tf.get_logger()
    logger.info('TensorFlow Version is: %s', tf.__version__)

```

```
Yes:
    import os
    from absl import logging

    logging.info('Current $PAGER is: %s', os.getenv('PAGER', default=''))

    homedir = os.getenv('HOME')
    if homedir is None or not os.access(homedir, os.W_OK):
        logging.error('Cannot write to home directory, $HOME=%r', homedir)

```

```
No:
    import os
    from absl import logging

    logging.info('Current $PAGER is:')
    logging.info(os.getenv('PAGER', default=''))

    homedir = os.getenv('HOME')
    if homedir is None or not os.access(homedir, os.W_OK):
        logging.error(f'Cannot write to home directory, $HOME={homedir!r}')

```



#### 3.10.2 错误消息

错误消息（例如：`ValueError` 等异常上的消息字符串，或向用户显示的消息）应当遵循三条指南：

1. 消息需要精确匹配实际错误条件。
2. 插值部分需要始终能被清楚识别为插值。
3. 它们应当允许简单的自动化处理（例如 grep）。

```
Yes:
    if not 0 <= p <= 1:
        raise ValueError(f'Not a probability: {p=}')

    try:
        os.rmdir(workdir)
    except OSError as error:
        logging.warning('Could not remove directory (reason: %r): %r',
                                        error, workdir)

```

```
No:
    if p < 0 or p > 1:  # PROBLEM: also false for float('nan')!
        raise ValueError(f'Not a probability: {p=}')

    try:
        os.rmdir(workdir)
    except OSError:
        # PROBLEM: Message makes an assumption that might not be true:
        # Deletion might have failed for some other reason, misleading
        # whoever has to debug this.
        logging.warning('Directory already was deleted: %s', workdir)

    try:
        os.rmdir(workdir)
    except OSError:
        # PROBLEM: The message is harder to grep for than necessary, and
        # not universally non-confusing for all possible values of `workdir`.
        # Imagine someone calling a library function with such code
        # using a name such as workdir = 'deleted'. The warning would read:
        # "The deleted directory could not be deleted."
        logging.warning('The %s directory could not be deleted.', workdir)

```



### 3.11 文件、套接字及类似有状态资源

用完文件与套接字后显式关闭它们。本规则自然延伸到内部使用套接字的可关闭资源，如数据库连接，以及其他需要以类似方式关闭的资源。仅举几例，这还包括 mmap 映射、h5py File 对象，以及 matplotlib.pyplot 图形窗口。

不必要地保持文件、套接字或其他此类有状态对象打开有许多弊端：

- 它们可能消耗有限的系统资源，如文件描述符。处理大量此类对象的代码若在使用后未及时归还给系统，可能不必要地耗尽这些资源。
- 保持文件打开可能阻止移动或删除它们，或卸载文件系统等其他操作。
- 在程序中共享的文件与套接字可能在逻辑上已关闭后仍被无意读或写。若它们实际已关闭，读写尝试将抛异常，使问题更早暴露。

此外，尽管文件与套接字（以及某些行为类似的资源）在对象析构时会自动关闭，将对象生命周期与资源状态耦合是不良实践：

- 不保证运行时何时实际调用 `__del__` 方法。不同 Python 实现使用不同内存管理技术，如延迟垃圾回收，可能任意且无限地延长对象生命周期。
- 对文件的意外引用，例如在全局变量或异常回溯中，可能使其保留得比预期更久。

依赖终结器做具有可观察副作用的自动清理，在数十年间、多种语言中一再被发现导致重大问题（例如参见这篇关于 Java 的文章）。

管理文件及类似资源的首选方式是使用 `with` 语句：

```
with open("hello.txt") as hello_file:
    for line in hello_file:
        print(line)

```

对不支持 `with` 语句的类文件对象，使用 `contextlib.closing()`：

```
import contextlib

with contextlib.closing(urllib.urlopen("http://www.python.org/")) as front_page:
    for line in front_page:
        print(line)

```

在基于上下文的资源管理不可行的罕见情况下，代码文档必须清楚说明资源生命周期如何管理。

### 3.12 TODO 注释

对临时、短期方案或够用但不完美的代码使用 `TODO` 注释。

`TODO` 注释以全大写单词 `TODO` 开头，后跟指向包含上下文之资源的括号链接，理想情况下是缺陷引用。缺陷引用更可取，因为缺陷会被跟踪并有后续评论。在此上下文片段后跟冒号与解释性字符串。

目的是拥有一致的 `TODO` 格式，以便搜索并了解如何获取更多细节。

```
# TODO(example.com/12345): Investigate cpufreq optimizations.

```

旧风格，曾被推荐，但新代码不鼓励使用：

```
# TODO: example.com/12345 - Investigate cpufreq optimizations.

```

避免添加以个人或团队为上下文的 TODO：

```
# TODO(username): File an issue and use a '*' for repetition.

```

若你的 `TODO` 形式为「在未来某日做某事」，务必包含非常具体的日期（「Fix by November 2009」）或非常具体的事件（「Remove this code when all clients can handle XML responses.」），以便未来的代码维护者能理解。用 issue 跟踪此事最为理想。

### 3.13 导入格式

导入应当各占一行；`typing` 与 `collections.abc` 导入有例外。

例如：

```
Yes: from collections.abc import Mapping, Sequence
     import os
     import sys
     from typing import Any, NewType

```

```
No:  import os, sys

```

导入始终放在文件顶部，紧接任何模块注释与文档字符串之后，模块全局变量与常量之前。导入应当从最通用到最不通用分组：

1. Python future 导入语句。例如：

```
from __future__ import annotations

```

更多信息见上文。
2. Python 标准库导入。例如：

```
import sys

```

1. 第三方模块或包导入。例如：

```
import tensorflow as tf

```

1. 代码仓库子包导入。例如：

```
from otherproject.ai import mind

```

1. 已弃用：与本文件属于同一顶层子包的应用专用导入。例如：

```
from myproject.backend.hgwells import time_machine

```

你可能发现较旧的 Google Python 风格代码这样写，但已不再要求。鼓励新代码不必再费心。只需将应用专用子包导入与其他子包导入同等对待。

在各组内，导入应当按每个模块的完整包路径（`from path import ...` 中的 `path`）忽略大小写按字典序排序。代码可以选择在导入分节之间放一个空行。

```
import collections
import queue
import sys

from absl import app
from absl import flags
import bs4
import cryptography
import tensorflow as tf

from book.genres import scifi
from myproject.backend import huxley
from myproject.backend.hgwells import time_machine
from myproject.backend.state_machine import main_loop
from otherproject.ai import body
from otherproject.ai import mind
from otherproject.ai import soul

# Older style code may have these imports down here instead:
#from myproject.backend.hgwells import time_machine
#from myproject.backend.state_machine import main_loop

```



### 3.14 语句

一般每行只有一条语句。

不过，仅当整个语句能放在一行时，你可以将测试结果与测试放在同一行。特别地，你永远不能对 `try`/`except` 这样做，因为 `try` 与 `except` 无法都放在同一行；对 `if` 仅当没有 `else` 时才能这样做。

```
Yes:

    if foo: bar(foo)

```

```
No:

    if foo: bar(foo)
    else:   baz(foo)

    try:               bar(foo)
    except ValueError: baz(foo)

    try:
            bar(foo)
    except ValueError: baz(foo)

```



### 3.15 Getter 与 Setter

当 getter 与 setter 函数（也称为访问器与修改器）在获取或设置变量值时提供有意义的角色或行为时，应当使用它们。

特别是，当获取或设置变量复杂，或代价显著（当前或在合理的未来）时，应当使用它们。

例如，若一对 getter/setter 仅读写内部属性，则应当改为公开该内部属性。相比之下，若设置变量意味着某些状态失效或重建，则应当是 setter 函数。函数调用暗示正在发生潜在非平凡操作。或者，在需要简单逻辑时，属性（properties）可以是一种选项，或者重构为不再需要 getter 与 setter。

Getter 与 setter 应当遵循命名指南，例如 `get_foo()` 与 `set_foo()`。

若过去行为允许通过属性访问，不要把新的 getter/setter 函数绑定到该属性。任何仍试图用旧方法访问变量的代码应当明显失败，以便他们意识到复杂度的变化。

### 3.16 命名

`module_name`、`package_name`、`ClassName`、`method_name`、`ExceptionName`、`function_name`、`GLOBAL_CONSTANT_NAME`、`global_var_name`、`instance_var_name`、`function_parameter_name`、`local_var_name`、`query_proper_noun_for_thing`、`send_acronym_via_https`。

名称应当具有描述性。这包括函数、类、变量、属性、文件以及任何其他类型的命名实体。

避免缩写。特别是，不要使用对项目外读者含糊或不熟悉的缩写，也不要通过删除单词内字母来缩写。

始终使用 `.py` 文件名扩展名。永远不要使用破折号。

#### 3.16.1 应避免的名称

- 单字符名称，除特别允许的情形外：
- 计数器或迭代器（例如 `i`、`j`、`k`、`v` 等）
- `try/except` 语句中作为异常标识符的 `e`
- `with` 语句中作为文件句柄的 `f`
- 无约束的私有类型变量（例如 `_T = TypeVar("_T")`、`_P = ParamSpec("_P")`）
- 与参考论文或算法中既定记号匹配的名称（见数学记号）

请注意不要滥用单字符命名。一般而言，描述性应当与名称的可见作用域成正比。例如，`i` 对 5 行代码块可能是好名称，但在多个嵌套作用域内往往过于含糊。

- 任何包/模块名中的破折号（`-`）
- `__double_leading_and_trailing_underscore__` 名称（由 Python 保留）
- 冒犯性用语
- 不必要地包含变量类型的名称（例如：`id_to_name_dict`）



#### 3.16.2 命名约定

- 一般遵循 PEP 8 命名约定。
- 「内部」指对模块内部，或类内受保护或私有。
- 前置单个下划线（`_`）对保护模块变量与函数有一定支持（linter 会标记对受保护成员的访问）。注意单元测试访问被测模块中的受保护常量是可以的。
- 在实例变量或方法前加双下划线（`__`，亦即「dunder」）实际上使该变量或方法对其类私有（使用名称修饰）；我们不鼓励使用，因为它影响可读性与可测试性，且并非真正私有。优先使用单个下划线。
- 将相关类与顶层函数放在同一模块中。与 Java 不同，不必限制每模块一个类。
- 类名使用 CapWords，但模块名使用 lower_with_under.py。尽管有一些旧模块命名为 CapWords.py，现已不鼓励，因为当模块恰好以类命名时令人困惑。（「等等——我写的是 `import StringIO` 还是 `from StringIO import StringIO`？」）
- 注意 PEP 8 说：「在 CapWords 中使用首字母缩略词时，将该缩略词的所有字母大写。因此 HTTPServerError 优于 HttpServerError。」
- 新的单元测试文件遵循符合 PEP 8 的 lower_with_under 方法名，例如 `test_<method_under_test>`_ 。为与遵循 CapWords 函数名的遗留模块保持一致(*)，以 `test` 开头的方法名中可以出现下划线以分隔名称的逻辑组成部分。一种可能模式是 `test _` 。



##### 3.16.2.1 豁免

下列豁免适用于上述一般命名约定：

- 当 Python 代码与外部或非 Python 代码库紧密耦合时，例如与 C++ 的外部函数接口（FFI），与另一代码库保持一致可能值得遵循不同约定（一致性）。



#### 3.16.3 文件命名

Python 文件名必须有 `.py` 扩展名，且不得包含破折号（`-`）。这使它们能够被导入与单元测试。若希望可执行文件无需扩展名即可访问，使用符号链接或包含 `exec "$0.py" "$@"` 的简单 bash 包装。

#### 3.16.4 源自 Guido 建议的指南


| 类型                         | 公共                   | 内部                         |
| -------------------------- | -------------------- | -------------------------- |
| Packages                   | `lower_with_under`   |                            |
| Modules                    | `lower_with_under`   | `_lower_with_under`        |
| Classes                    | `CapWords`           | `_CapWords`                |
| Exceptions                 | `CapWords`           |                            |
| Functions                  | `lower_with_under()` | `_lower_with_under()`      |
| Global/Class Constants     | `CAPS_WITH_UNDER`    | `_CAPS_WITH_UNDER`         |
| Global/Class Variables     | `lower_with_under`   | `_lower_with_under`        |
| Instance Variables         | `lower_with_under`   | `_lower_with_under`（受保护）   |
| Method Names               | `lower_with_under()` | `_lower_with_under()`（受保护） |
| Function/Method Parameters | `lower_with_under`   |                            |
| Local Variables            | `lower_with_under`   |                            |




#### 3.16.5 数学记号

对数学密集的代码，当短变量名与参考论文或算法中的既定记号匹配时，即使它们原本会违反风格指南，也优先使用。

使用基于既定记号的名称时：

1. 在注释或文档字符串中引用所有命名约定的来源，最好带指向学术资源本身的超链接。若来源不可访问，清楚记录命名约定。
2. 对公共 API 优先使用符合 PEP 8 的 `descriptive_names`，它们更可能在脱离上下文时被遇到。
3. 使用范围狭窄的 `pylint: disable=invalid-name` 指令以静默警告。对仅少数变量，对每个使用行末指令；对更多变量，在块开头应用该指令。



### 3.17 Main

在 Python 中，`pydoc` 以及单元测试要求模块可导入。若文件意在作为可执行文件使用，其主要功能应当放在 `main()` 函数中，且代码应当始终在执行主程序前检查 `if __name__ == '__main__'`，以便导入模块时不会执行。

使用 absl 时，使用 `app.run`：

```
from absl import app
...

def main(argv: Sequence[str]):
    # process non-flag arguments
    ...

if __name__ == '__main__':
    app.run(main)

```

否则，使用：

```
def main():
    ...

if __name__ == '__main__':
    main()

```

模块导入时，顶层所有代码都会执行。注意不要调用函数、创建对象或执行其他在文件被 `pydoc` 时不应当执行的操作。

### 3.18 函数长度

优先使用小而专注的函数。

我们承认长函数有时是合适的，因此不对函数长度设置硬性限制。若函数超过约 40 行，思考是否可以在不损害程序结构的情况下拆分。

即使你的长函数现在完美工作，几个月后修改它的人可能添加新行为。这可能导致难以发现的缺陷。保持函数短小简单，使其他人更容易阅读与修改你的代码。

处理某些代码时你可能遇到又长又复杂的函数。不要被修改现有代码吓倒：若处理此类函数证明困难、发现错误难以调试，或想在多个不同语境中使用其中一块，考虑将函数拆成更小、更易管理的部分。

### 3.19 类型注解



#### 3.19.1 一般规则

- 熟悉类型提示。
- 一般不必注解 `self` 或 `cls`。若为获得正确类型信息有必要，可以使用 `Self`，例如

```
from typing import Self

class BaseClass:
    @classmethod
    def create(cls) -> Self:
        ...

    def difference(self, other: Self) -> float:
        ...

```

- 类似地，不必觉得必须注解 `__init__` 的返回值（`None` 是唯一有效选项）。
- 若任何其他变量或返回类型不应当被表达，使用 `Any`。
- 你不必注解模块中的所有函数。
- 至少注解你的公共 API。
- 用判断在安全与清晰的一方与灵活性的另一方之间取得良好平衡。
- 注解容易出现类型相关错误的代码（既往缺陷或复杂性）。
- 注解难以理解的代码。
- 当代码从类型角度看趋于稳定时再注解。许多情况下，你可以注解成熟代码中的所有函数而不失去太多灵活性。



#### 3.19.2 断行

尽量遵循现有缩进规则。

注解后，许多函数签名会变成「每行一个参数」。为确保返回类型也独占一行，可以在最后一个参数后加逗号。

```
def my_method(
        self,
        first_var: int,
        second_var: Foo,
        third_var: Bar | None,
) -> int:
    ...

```

始终优先在变量之间断行，而不是例如在变量名与类型注解之间。不过，若一切都能放在同一行，就这样做。

```
def my_method(self, first_var: int) -> int:
    ...

```

若函数名、最后一个参数与返回类型的组合过长，在新行上缩进 4。使用断行时，优先将每个参数与返回类型各占一行，并将闭括号与 `def` 对齐：

```
Yes:
    def my_method(
        self,
        other_arg: MyLongType | None,
    ) -> tuple[MyLongType1, MyLongType1]:
      ...

```

可选地，返回类型可以与最后一个参数放在同一行：

```
Okay:
def my_method(
        self,
        first_var: int,
        second_var: int) -> dict[OtherLongType, MyLongType]:
    ...

```

`pylint` 允许你将闭括号移到新行并与开括号对齐，但这较难读。

```
No:
    def my_method(self,
                  other_arg: MyLongType | None,
                 ) -> dict[OtherLongType, MyLongType]:
      ...

```

如同上文示例，优先不断开类型。不过，有时它们太长无法放在单行（尽量保持子类型不断开）。

```
def my_method(
    self,
    first_var: tuple[list[MyLongType1],
                     list[MyLongType2]],
    second_var: list[dict[
        MyLongType3, MyLongType4]],
) -> None:
    ...

```

若单个名称与类型过长，考虑为该类型使用别名。最后手段是在冒号后断行并缩进 4。

```
Yes:
    def my_function(
        long_variable_name:
            long_module_name.LongTypeName,
    ) -> None:
      ...

```

```
No:
    def my_function(
        long_variable_name: long_module_name.
            LongTypeName,
    ) -> None:
      ...

```



#### 3.19.3 前向声明

若需要使用尚未定义的类名（来自同一模块）——例如，若需要在该类的声明内部使用类名，或使用稍后在代码中定义的类——要么使用 `from __future__ import annotations`，要么对该类名使用字符串。

```
Yes:
    from __future__ import annotations

    class MyClass:
      def __init__(self, stack: Sequence[MyClass], item: OtherClass) -> None:

    class OtherClass:
      ...

```

```
Yes:
    class MyClass:
      def __init__(self, stack: Sequence['MyClass'], item: 'OtherClass') -> None:

    class OtherClass:
      ...

```



#### 3.19.4 默认值

按 PEP-008，仅对同时具有类型注解与默认值的参数，在 `=` 周围使用空格。

```
Yes:
    def func(a: int = 0) -> int:
      ...

```

```
No:
    def func(a:int=0) -> int:
      ...

```



#### 3.19.5 NoneType

在 Python 类型系统中，`NoneType` 是「一等」类型，且就类型而言，`None` 是 `NoneType` 的别名。若参数可以为 `None`，就必须声明！你可以使用 `|` 联合类型表达式（在新的 Python 3.10+ 代码中推荐），或较旧的 `Optional` 与 `Union` 语法。

使用显式的 `X | None` 而非隐式。早期版本的类型检查器允许将 `a: str = None` 解释为 `a: str | None = None`，但那已不再是首选行为。

```
Yes:
    def modern_or_union(a: str | int | None, b: str | None = None) -> str:
      ...
    def union_optional(a: Union[str, int, None], b: Optional[str] = None) -> str:
      ...

```

```
No:
    def nullable_union(a: Union[None, str]) -> str:
      ...
    def implicit_optional(a: str = None) -> str:
      ...

```



#### 3.19.6 类型别名

你可以声明复杂类型的别名。

- 别名名称应当为 CapWords。若别名仅在本模块使用，应当为 _Private。
- 别名应当类型注解为 `typing.TypeAlias`，以区别于非类型的全局变量。
- 不要用类型别名替代不允许的 `from module import symbol` 惯用法。

```
Yes:
    from typing import TypeAlias

    _LossAndGradient: TypeAlias = tuple[tf.Tensor, tf.Tensor]
    ComplexTFMap: TypeAlias = Mapping[str, _LossAndGradient]

```

```
No:
    import immutabledict

    immutabledict = immutabledict.immutabledict

```

```
# Acceptable for convenience (provided the alias is not used in a public API,
# such as a public function's signature, of this module).
_ShortName: TypeAlias = other_module.SignificantlyInconvenientlyLongName

```



#### 3.19.7 忽略类型

你可以用特殊注释 `# type: ignore` 禁用一行上的类型检查。

`pyrefly` 有针对特定错误的禁用选项（类似 lint）：

```
# pyrefly: ignore[attribute-error]

```



#### 3.19.8 为变量加类型

注解赋值
: 若内部变量的类型难以或无法推断，用注解赋值指定其类型——在变量名与值之间使用冒号与类型（与带默认值的函数参数相同）：

```
a: Foo = SomeUndecoratedFunction()

```

类型注释
: 尽管你可能在代码库中仍看到它们（在 Python 3.6 之前是必要的），不要再添加任何行末 `# type:`  注释的新用法：

```
a = SomeUndecoratedFunction()  # type: Foo

```



#### 3.19.9 元组与列表

类型化列表只能包含单一类型的对象。类型化元组既可以有单个重复类型，也可以有固定数量、不同类型的元素。后者常作为函数的返回类型使用。

```
a: list[int] = [1, 2, 3]
b: tuple[int, ...] = (1, 2, 3)
c: tuple[int, str, float] = (1, "2", 3.5)

```



#### 3.19.10 类型变量

Python 类型系统有泛型。`TypeVar` 与 `ParamSpec` 等类型变量是使用它们的常见方式。

```
from collections.abc import Callable
from typing import ParamSpec, TypeVar
_P = ParamSpec("_P")
_T = TypeVar("_T")
...
def next(l: list[_T]) -> _T:
    return l.pop()

def print_when_called(f: Callable[_P, _T]) -> Callable[_P, _T]:
    def inner(*args: _P.args, **kwargs: _P.kwargs) -> _T:
        print("Function was called")
        return f(*args, **kwargs)
    return inner

```

`TypeVar` 可以有约束：

```
AddableType = TypeVar("AddableType", int, float, str)
def add(a: AddableType, b: AddableType) -> AddableType:
    return a + b

```

`typing` 模块中一个常见的预定义类型变量是 `AnyStr`。当多个注解可以是 `bytes` 或 `str` 且必须全部为同一类型时使用它。

```
from typing import AnyStr
def check_length(x: AnyStr) -> AnyStr:
    if len(x) <= 42:
        return x
    raise ValueError()

```

类型变量必须有描述性名称，除非它满足下列全部条件：

- 不对外可见
- 无约束

```
Yes:
    _T = TypeVar("_T")
    _P = ParamSpec("_P")
    AddableType = TypeVar("AddableType", int, float, str)
    AnyFunction = TypeVar("AnyFunction", bound=Callable)

```

```
No:
    T = TypeVar("T")
    P = ParamSpec("P")
    _T = TypeVar("_T", int, float, str)
    _F = TypeVar("_F", bound=Callable)

```



#### 3.19.11 字符串类型

> 新代码中不要使用 `typing.Text`。它仅用于 Python 2/3 兼容。

对字符串/文本数据使用 `str`。对处理二进制数据的代码使用 `bytes`。

```
def deals_with_text_data(x: str) -> str:
    ...
def deals_with_binary_data(x: bytes) -> bytes:
    ...

```

若函数的所有字符串类型始终相同，例如若返回类型与上文代码中的参数类型相同，使用 AnyStr。

#### 3.19.12 类型导入

对来自 `typing` 或 `collections.abc` 模块、用于支持静态分析与类型检查的符号（包括类型、函数与常量），始终导入符号本身。这使常见注解更简洁，并与世界各地使用的类型实践一致。你被明确允许从 `typing` 与 `collections.abc` 模块在一行上导入多个具体符号。例如：

```
from collections.abc import Mapping, Sequence
from typing import Any, Generic, cast, TYPE_CHECKING

```

鉴于这种导入方式会将项加入本地命名空间，`typing` 或 `collections.abc` 中的名称应当类似关键字对待，不要在你的 Python 代码中定义它们（无论是否有类型）。若类型与模块中已有名称冲突，使用 `import x as y` 导入。

```
from typing import Any as AnyType

```

注解函数签名时，优先使用 `collections.abc.Sequence` 等抽象容器类型，而非 `list` 等具体类型。若需要使用具体类型（例如类型化元素的 `tuple`），优先使用 `tuple` 等内置类型，而非 `typing` 模块中的参数化类型别名（例如 `typing.Tuple`）。

```
from typing import List, Tuple

def transform_coordinates(original: List[Tuple[float, float]]) ->
        List[Tuple[float, float]]:
    ...

```

```
from collections.abc import Sequence

def transform_coordinates(original: Sequence[tuple[float, float]]) ->
        Sequence[tuple[float, float]]:
    ...

```



#### 3.19.13 条件导入

仅在必须避免运行时加载仅为类型检查所需的额外导入的例外情况下使用条件导入。不鼓励此模式；应当优先采用重构代码以允许顶层导入等替代方案。

仅类型注解所需的导入可以放在 `if TYPE_CHECKING:` 块内。

- 条件导入的类型需要以字符串引用，以便与 Python 3.6 前向兼容，在该版本中注解表达式会被实际求值。
- 此处只应当定义仅用于类型的实体；这包括别名。否则将是运行时错误，因为运行时不会导入该模块。
- 该块应当紧接在所有普通导入之后。
- 类型导入列表中不应当有空行。
- 像普通导入列表一样排序此列表。

```
import typing
if typing.TYPE_CHECKING:
    import sketch
def f(x: "sketch.Sketch"): ...

```



#### 3.19.14 循环依赖

由类型引起的循环依赖是代码异味。此类代码是重构的良好候选。尽管技术上可以保持循环依赖，各种构建系统不会允许你这样做，因为每个模块都必须依赖另一个。

用 `Any` 替换造成循环依赖导入的模块。设置有意义名称的别名，并使用来自该模块的真实类型名（`Any` 的任何属性都是 `Any`）。别名定义应当与最后一个导入隔开一行。

```
from typing import Any

some_mod = Any  # some_mod.py imports this module.
...

def my_method(self, var: "some_mod.SomeType") -> None:
    ...

```



#### 3.19.15 泛型

注解时，优先在参数列表中为泛型类型指定类型参数；否则泛型的参数将假定为 `Any`。

```
# Yes:
def get_names(employee_ids: Sequence[int]) -> Mapping[int, str]:
    ...

```

```
# No:
# This is interpreted as get_names(employee_ids: Sequence[Any]) -> Mapping[Any, Any]
def get_names(employee_ids: Sequence) -> Mapping:
    ...

```

若泛型的最佳类型参数是 `Any`，使其显式，但记住在许多情况下 `TypeVar` 可能更合适：

```
# No:
def get_names(employee_ids: Sequence[Any]) -> Mapping[Any, str]:
    """Returns a mapping from employee ID to employee name for given IDs."""

```

```
# Yes:
_T = TypeVar('_T')
def get_names(employee_ids: Sequence[_T]) -> Mapping[_T, str]:
    """Returns a mapping from employee ID to employee name for given IDs."""

```



## 4 结语

保持一致。

若你在编辑代码，花几分钟看看周围代码并确定其风格。若他们在索引变量名中使用 `_idx` 后缀，你也应当如此。若他们的注释有井号围成的小框，你的注释也要有井号小框。

拥有风格指南的意义在于拥有共同的编码词汇，以便人们能专注于你在说什么，而非你怎么说。我们在此呈现全局风格规则以便人们了解词汇，但本地风格也很重要。若你向文件添加的代码与周围现有代码看起来截然不同，读者阅读时会被打乱节奏。

不过，一致性有限度。它更重地适用于本地以及全局风格未规定的选择。一般不应当用一致性作为借口，在不考虑新风格益处或代码库随时间向较新风格收敛趋势的情况下，继续按旧风格做事。
