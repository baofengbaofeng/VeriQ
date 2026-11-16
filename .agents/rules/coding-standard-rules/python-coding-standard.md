# Python coding standard

下面的 VeriQ 改编是规范性的，与 Google 原文不一致时以这里为准。

- 代码块使用 4 个空格缩进。禁止使用 Tab。文档字符串的悬挂缩进是 4 个空格。示例里若仍出现 2 个空格的悬挂缩进，那只是反例。
- 代码行最多 120 个字符，行宽一节列出的例外除外。
- 注释，包括文档字符串和行内说明，使用中文。产品名 VeriQ 和技术标识可以保持原文。
- 注释块的第一行至少包含 40 个字符的注释文字。说明这段代码在做什么，不要用口号凑长度。
- 每一行注释最多 120 个字符，超出部分换行。机器指令（`pylint:`、`pyrefly:`、`# type:`）或无法拆开的 URL 可以单独占一行，因为拆开会改变语法。



## 1 背景

Python 是 Google 使用的主要动态语言。本风格指南列出 Python 程序应当遵守和应当避免的做法。

为了帮助正确排版代码，我们准备了 Vim 的设置文件。Emacs 使用默认设置即可。

许多团队使用 Black 或 Pyink 自动格式化，以免在格式上争论。

## 2 Python 语言规则

### 2.1 静态检查

用这份 pylintrc 对代码运行 `pylint`。

#### 2.1.1 定义

`pylint` 用来发现 Python 源代码中的缺陷和风格问题。它能找出在 C、C++ 这类静态程度更高的语言里通常由编译器捕获的问题。由于 Python 是动态的，有些警告可能不正确；不过误报应当相当少见。

#### 2.1.2 优点

能抓住容易漏掉的错误，例如拼写错误、使用尚未赋值的变量等。

#### 2.1.3 缺点

`pylint` 并不完美。要用好它，有时需要绕开它、抑制警告，或者修正工具本身。

#### 2.1.4 决定

务必对自己的代码运行 `pylint`。

不恰当的警告应当抑制，以免其他问题被淹没。抑制警告时可以写行级注释：

```
# WSGI 要求方法名保持 do_PUT 这种协议拼写，因此只在这一行关掉 invalid-name，不把方法改成蛇形。
def do_PUT(self):  # pylint: disable=invalid-name
    ...

```

`pylint` 的每条警告都有符号名（`empty-docstring`）。Google 专用警告以 `g-` 开头。

如果符号名本身看不出抑制原因，就补上说明。

这种抑制方式便于搜索，也便于以后回来复查。

可以用下面的命令列出 `pylint` 警告：

```
pylint --list-msgs

```

要查看某一条消息的详细说明，使用：

```
pylint --help-msg=invalid-name

```

优先使用 `pylint: disable`，不要再用已经废弃的 `pylint: disable-msg`。

未使用参数的警告可以在函数开头删掉这些变量来抑制。必须用中文注释说明为什么删除。该注释块的第一行至少 40 个字符。“Unused.” 不够。例如：

```
def viking_cafe_order(spam: str, beans: str, eggs: str | None = None) -> str:
    del beans, eggs  # 维京人这份订单不读取豆子和鸡蛋，删掉它们是为了标明参数未使用，而不是改成空字符串。
    return spam + spam + spam

```

抑制这条警告的其他常见写法包括：把未使用参数的标识写成 ‘`_`’，给参数名加上 ‘`unused_`’ 前缀，或者把它们赋给 ‘`_`’。这些写法允许，但不再鼓励。它们会破坏按名字传参的调用方，也不能强制这些参数真的未被使用。

### 2.2 导入

`import` 语句只用于导入包和模块，不用于导入单个类型、类或函数。

#### 2.2.1 定义

把一个模块里的代码共享给另一个模块的复用机制。

#### 2.2.2 优点

命名空间约定简单。每个标识的来源都以同一种方式标明；`x.Obj` 表示对象 `Obj` 定义在模块 `x` 里。

#### 2.2.3 缺点

模块名仍然可能冲突。有些模块名长得不方便。

#### 2.2.4 决定

- 导入包和模块时使用 `import x`。
- 使用 `from x import y`，其中 `x` 是包前缀，`y` 是不带前缀的模块名。
- 在下列任一情况下使用 `from x import y as z`：

- 要导入两个都叫 `y` 的模块。
- `y` 与当前模块里定义的顶层名字冲突。
- `y` 与公共 API 里的常见参数名冲突（例如 `features`）。
- `y` 这个名字长得不方便。
- 在这段代码的上下文里 `y` 太笼统（例如 `from storage.file_system import options as fs_options`）。
- 只有当 `z` 是标准缩写时才使用 `import y as z`（例如 `import numpy as np`）。

例如模块 `sound.effects.echo` 可以这样导入：

```
from sound.effects import echo
...
echo.EchoFilter(input, output, delay=0.7, atten=4)

```

导入时不要使用相对名字。即使模块在同一个包里，也使用完整包名。这样可以避免无意中把同一个包导入两次。

##### 2.2.4.1 例外

下列模块里用于支持静态分析和类型检查的符号不受本条规则约束：

- `typing` 模块
- `collections.abc` 模块
- `typing_extensions` 模块

### 2.3 包

按模块的完整路径位置导入每个模块。

#### 2.3.1 优点

避免模块名冲突，也避免因为模块搜索路径和作者预期不同而导错。模块也更容易找到。

#### 2.3.2 缺点

部署时必须复制包的层次结构，因此更麻烦。对现代部署机制来说，这其实不算问题。

#### 2.3.3 决定

所有新代码都应按完整包名导入每个模块。

导入应写成这样：

```
Yes:
    # 这里用完整模块名 absl.flags 引用旗标，读者不用猜 flags 是从哪一个包导入的。
    import absl.flags
    from doctor.who import jodie

    _FOO = absl.flags.DEFINE_string(...)

```

```
Yes:
    # 从 absl 导入 flags 模块后，用模块名调用即可，不必每次写出 absl.flags 这个完整前缀。
    from absl import flags
    from doctor.who import jodie

    _FOO = flags.DEFINE_string(...)

```

（假定本文件位于 `doctor/who/`，同目录还有 `jodie.py`）

```
No:
    # 反例只写 import jodie，读者无法判断要的是同目录文件还是第三方包，实际导入还取决于 sys.path。
    import jodie

```

不要假定主程序所在目录位于 `sys.path` 中，尽管有些环境确实如此。因此代码应假定 `import jodie` 指向名为 `jodie` 的第三方或顶层包，而不是本地的 `jodie.py`。

### 2.4 异常

允许使用异常，但必须谨慎。

#### 2.4.1 定义

异常用于跳出正常控制流，以便处理错误或其他异常情况。

#### 2.4.2 优点

正常操作的控制流不会被错误处理代码搅乱。它也允许在某个条件出现时一次跳过多层栈帧，例如从 N 层嵌套函数一步返回，而不必把错误码逐层传上去。

#### 2.4.3 缺点

可能让控制流变得难懂。调用库时容易漏掉错误情况。

#### 2.4.4 决定

异常必须满足下列条件：

- 合适时使用内置异常类。例如用 `ValueError` 表示编程错误，比如违反了前置条件，验证函数参数时就可能发生这种情况。
- 不要用 `assert` 代替条件判断或前置条件校验。它们不得成为应用逻辑的关键部分。检验标准是：删掉 `assert` 之后代码仍然成立。`assert` 中的条件不保证会被求值。基于 pytest 的测试里，用 `assert` 核对预期是可以的，也是预期做法。例如：

```
Yes:
    def connect_to_next_port(self, minimum: int) -> int:
        """从调用方传入的端口下限开始寻找，连上下一个可用端口之后，把新端口交还给调用方，本例就是这样。

        Args:
            minimum: 端口下限，必须大于或等于 1024。
        Returns:
            实际连上的新端口，作为下一次搜索的下限。
        Raises:
            ConnectionError: 从下限往上找不到可以连接的端口。
        """
        if minimum < 1024:
            # 这里抛出 ValueError 是因为调用方违反了端口下限，文档的 Raises 不承诺这种误用会得到哪一种具体异常。
            raise ValueError(f'Min. port must be at least 1024, not {minimum}.')
        port = self._find_next_open_port(minimum)
        if port is None:
            raise ConnectionError(
                    f'Could not connect to service on port {minimum} or higher.')
        # 后面的逻辑不依赖这条 assert 的结果，它只在开发时确认端口没有小于调用方给出的下限。
        assert port >= minimum, (
                f'Unexpected port {port} when minimum was {minimum}.')
        return port

```

```
No:
    def connect_to_next_port(self, minimum: int) -> int:
        """从调用方传入的端口下限开始寻找，连上下一个可用端口之后，把新端口交还给调用方，本例就是这样。

        Args:
            minimum: 端口下限，必须大于或等于 1024。
        Returns:
            实际连上的新端口。反例没有列出失败时的异常。
        """
        assert minimum >= 1024, 'Minimum port must be at least 1024.'
        # 后面的查找直接使用 assert 留下的假设，assert 被关掉后这个前提就不再成立。
        port = self._find_next_open_port(minimum)
        assert port is not None
        # 返回语句的类型收窄依赖上一条 assert，检查器否则无法排除端口为 None。
        return port

```
- 库或包可以定义自己的异常。此时必须继承已有的异常类。异常名应以 `Error` 结尾，并且不要重复（`foo.FooError`）。
- 绝不要使用笼统的 `except:`，也不要捕获 `Exception` 或 `StandardError`，除非你是在

- 重新抛出该异常，或者
- 在程序里建立隔离点：异常不继续传播，而是被记录并抑制，例如在线程最外层拦住异常，避免线程崩溃。

Python 在这方面非常宽松，`except:` 真的会抓住一切，包括拼错的名字、`sys.exit()` 调用、Ctrl+C 中断、单元测试失败，以及各种你根本不想捕获的异常。
- 尽量减少 `try`/`except` 块里的代码。`try` 的主体越大，就越可能有一行你没料到会抛异常的代码抛出异常。那时 `try`/`except` 会把真正的错误藏起来。
- 用 `finally` 子句执行无论 `try` 块是否抛出异常都要运行的代码。这常用于清理，例如关闭文件。

### 2.5 可变全局状态

避免可变的全局状态。

#### 2.5.1 定义

程序执行期间可能被修改的模块级值或类属性。

#### 2.5.2 优点

偶尔有用。

#### 2.5.3 缺点

- 破坏封装：这种设计会让正当目标难以实现。例如若用全局状态管理数据库连接，就很难同时连接两个不同的数据库（比如迁移时计算差异）。全局注册表也容易出现类似问题。
- 可能在导入期间改变模块行为，因为对全局变量的赋值发生在模块第一次被导入时。

#### 2.5.4 决定

避免可变的全局状态。

在确实有理由使用全局状态的少数情况下，可变全局实体应声明在模块级或作为类属性，并在名字前加 `_` 使其成为内部名字。如果外部必须访问可变全局状态，应通过公开函数或类方法。见下面的命名一节。请在注释里，或在注释所链到的文档里，说明为什么使用可变全局状态。

允许并鼓励模块级常量。例如内部常量 `_MAX_HOLY_HANDGRENADE_COUNT = 3`，或公共 API 常量 `SIR_LANCELOTS_FAVORITE_COLOR = "blue"`。常量必须使用全大写加下划线的名字。见下面的命名一节。

### 2.6 嵌套、局部与内部的类和函数

嵌套的局部函数或类在需要闭合局部变量时可以使用。内部类也可以。

#### 2.6.1 定义

类可以定义在方法、函数或类里面。函数可以定义在方法或函数里面。嵌套函数对外围作用域里定义的变量只有只读访问。

#### 2.6.2 优点

可以定义只在很窄范围内使用的工具类和工具函数。很像抽象数据类型。实现装饰器时常用。

#### 2.6.3 缺点

嵌套的函数和类不能直接测试。嵌套会让外层函数更长、更难读。

#### 2.6.4 决定

可以使用，但有一些限制。除了闭合 `self` 或 `cls` 以外的局部值，避免嵌套函数或类。不要只为了对模块使用者隐藏某个函数而把它嵌进去。应在模块级给它的名字加上 `_` 前缀，这样测试仍然可以访问它。

### 2.7 推导式与生成器表达式

简单情况可以使用。

#### 2.7.1 定义

列表、字典和集合推导式以及生成器表达式，提供了一种简洁高效的方式来创建容器类型和迭代器，而不必使用传统循环、`map()`、`filter()` 或 `lambda`。

#### 2.7.2 优点

简单推导式可以比其他创建字典、列表或集合的手法更清楚、更简单。生成器表达式可以非常高效，因为它们完全不创建列表。

#### 2.7.3 缺点

复杂的推导式或生成器表达式很难读。

#### 2.7.4 决定

允许使用推导式，但不允许多个 `for` 子句或过滤表达式。优先考虑可读性，而不是简短。

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

对支持它们的类型使用默认迭代器和运算符，例如列表、字典和文件。

#### 2.8.1 定义

字典和列表这类容器类型定义了默认迭代器，以及成员测试运算符（“in” 和 “not in”）。

#### 2.8.2 优点

默认迭代器和运算符简单、高效。它们直接表达操作，不需要额外的方法调用。使用默认运算符的函数是通用的，可以用于任何支持该操作的类型。

#### 2.8.3 缺点

单看方法名无法判断对象的类型（除非变量带有类型注解）。这也是一个优点。

#### 2.8.4 决定

对支持它们的类型使用默认迭代器和运算符，例如列表、字典和文件。内置类型也定义了迭代器方法。优先使用这些方法，而不是返回列表的方法，但迭代容器时不要修改它。

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

需要时使用生成器。

#### 2.9.1 定义

生成器函数返回一个迭代器，每次执行 yield 语句时产生一个值。产生一个值之后，生成器函数的运行时状态会挂起，直到需要下一个值。

#### 2.9.2 优点

代码更简单，因为每次调用都会保留局部变量和控制流的状态。生成器比一次创建整份值列表的函数占用更少内存。

#### 2.9.3 缺点

生成器里的局部变量要等到生成器被消耗完，或者生成器本身被垃圾回收，才会被回收。

#### 2.9.4 决定

可以使用。生成器函数的文档字符串里用 “Yields:”，不要用 “Returns:”。

如果生成器管理昂贵资源，务必强制清理。

一种好的清理方式是用上下文管理器包住生成器，见 PEP-0533。

### 2.10 Lambda 函数

单行可以使用。优先使用生成器表达式，而不是带 `lambda` 的 `map()` 或 `filter()`。

#### 2.10.1 定义

Lambda 在表达式里定义匿名函数，而不是在语句里定义。

#### 2.10.2 优点

方便。

#### 2.10.3 缺点

比局部函数更难读、更难调试。没有名字会让栈追踪更难理解。表达能力有限，因为函数体只能是一个表达式。

#### 2.10.4 决定

允许使用 lambda。如果 lambda 函数里的代码跨越多行，或长于 60 到 80 个字符，最好把它定义成普通的嵌套函数。

对乘法这类常见运算，使用 `operator` 模块里的函数，不要用 lambda。例如优先使用 `operator.mul`，而不是 `lambda x, y: x * y`。

### 2.11 条件表达式

简单情况可以使用。

#### 2.11.1 定义

条件表达式（有时称为“三元运算符”）为 if 语句提供更短的语法。例如：`x = 1 if cond else 2`。

#### 2.11.2 优点

比 if 语句更短、更方便。

#### 2.11.3 缺点

可能比 if 语句更难读。表达式很长时，条件可能不容易找到。

#### 2.11.4 决定

简单情况可以使用。每一部分都必须放在一行里：真值表达式、if 表达式、else 表达式。事情变复杂时，使用完整的 if 语句。

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

多数情况可以使用。

#### 2.12.1 定义

可以在函数参数列表末尾为变量指定值，例如 `def foo(a, b=0):`。如果调用 `foo` 时只传一个参数，`b` 被设为 0。如果传两个参数，`b` 取第二个参数的值。

#### 2.12.2 优点

常常有一个函数使用很多默认值，但偶尔想覆盖这些默认值。默认参数值提供了一种简便做法，不必为这些罕见例外再定义许多函数。Python 不支持重载方法或函数，默认参数是“仿造”重载行为的简便方式。

#### 2.12.3 缺点

默认参数在模块加载时只求值一次。如果参数是列表或字典这类可变对象，可能出问题。如果函数修改了该对象（例如往列表里追加一项），默认值也会被改掉。

#### 2.12.4 决定

可以使用，但有下列限制：

不要在函数或方法定义里把可变对象用作默认值。

```
Yes: def foo(a, b=None):
         if b is None:
             b = []
Yes: def foo(a, b: Sequence | None = None):
         if b is None:
             b = []
# 空元组不可变，拿它当默认值不会在多次调用之间被改掉，调用方每次看到的都是同一个空元组。
Yes: def foo(a, b: Sequence = ()):
         ...

```

```
from absl import flags
_FOO = flags.DEFINE_string(...)

No:  def foo(a, b=[]):
         ...
No:  def foo(a, b=time.time()):  # 默认值在模块导入时就算好，b 会固定成导入那一刻，而不是函数每次被调用时的当前时间。
         ...
No:  def foo(a, b=_FOO.value):  # 函数定义时旗标还没有解析，把 _FOO.value 写进默认值会拿到解析前的空值。
         ...
# 把可变的空字典当作默认映射时，调用方可能把它继续传给不会复制实参的下游代码，本例就是这样。
No:  def foo(a, b: Mapping = {}):
         ...

```

### 2.13 属性

属性可以用来控制那些只需少量计算或逻辑的读取和设置。属性的实现必须符合普通属性访问的一般预期：便宜、直接、不出人意料。

#### 2.13.1 定义

把获取和设置属性的方法调用包装成标准属性访问的方式。

#### 2.13.2 优点

- 提供属性访问和赋值的 API，而不是读取器和设置器方法调用。
- 可以用来把属性做成只读。
- 允许把计算推迟到使用时。
- 当内部实现独立于类的使用者演进时，可以维持类的公共接口。

#### 2.13.3 缺点

- 可能像运算符重载一样藏起副作用。
- 可能让子类感到困惑。

#### 2.13.4 决定

允许使用属性，但和运算符重载一样，只在必要时使用，并且要符合典型属性访问的预期；否则遵循读取器与设置器的规则。

例如，不允许用属性仅仅同时读取和设置一个内部属性：这里没有计算，属性是多余的（应把该属性公开）。相比之下，允许用属性控制属性访问，或计算一个轻易就能得出的派生值：逻辑简单，也不出人意料。

属性应使用 `@property` 装饰器创建。手工实现属性描述符被视为高级特性。

属性与继承的关系可能并不明显。不要用属性实现子类将来可能想覆盖并扩展的计算。

### 2.14 真与假的求值

尽可能使用“隐式”假（有几条例外）。

#### 2.14.1 定义

在布尔上下文中，Python 会把某些值求值为 `False`。一条快速的经验是：所有“空”值都被视为假，因此 `0, None, [], {}, ''` 在布尔上下文中都为假。

#### 2.14.2 优点

使用 Python 布尔值的条件更容易读，也不容易出错。多数情况下也更快。

#### 2.14.3 缺点

对 C/C++ 开发者来说可能显得奇怪。

#### 2.14.4 决定

尽可能使用“隐式”假，例如用 `if foo:`，而不是 `if foo != []:`。不过要记住几条例外：

- 检查 `None` 时始终使用 `if foo is None:`（或 `is not None`）。例如测试一个默认值为 `None` 的变量或参数是否被设成了别的值。那个别的值在布尔上下文里也可能为假！
- 绝不要用 `==` 把布尔变量和 `False` 比较。改用 `if not x:`。如果需要区分 `False` 和 `None`，把表达式串起来，例如 `if not x and x is not None:`。
- 对序列（字符串、列表、元组），利用空序列为假这一事实，因此 `if seq:` 和 `if not seq:` 分别优于 `if len(seq):` 和 `if not len(seq):`。
- 处理整数时，隐式假的风险可能大于收益（例如不小心把 `None` 当成 0）。可以把已知是整数、且不是 `len()` 结果的值与整数 0 比较。

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
- 注意 `'0'`（也就是字符串形式的 `0`）求值为真。
- 注意 Numpy 数组在隐式布尔上下文中可能抛出异常。测试 `np.array` 是否为空时，优先使用 `.size` 属性（例如 `if not users.size`）。

### 2.16 词法作用域

可以使用。

#### 2.16.1 定义

嵌套的 Python 函数可以引用外层函数里定义的变量，但不能给它们赋值。变量绑定按词法作用域解析，也就是依据静态程序文本。块里对某个名字的任何赋值都会让 Python 把对该名字的所有引用都当成局部变量，即使使用出现在赋值之前。如果出现 global 声明，该名字被视为全局变量。

这个特性的用例如下：

```
def get_adder(summand1: float) -> Callable[[float], float]:
    """返回的闭包会把后来传入的数加到构造时给定的加数上，加数在闭包创建时就已经固定，本例就是这样。
    """
    def adder(summand2: float) -> float:
        return summand1 + summand2

    return adder

```

#### 2.16.2 优点

常常得到更清楚、更优雅的代码。对有经验的 Lisp 和 Scheme（以及 Haskell 和 ML 等）程序员尤其熟悉。

#### 2.16.3 缺点

可能导致令人困惑的缺陷，例如这个基于 PEP-0227 的例子：

```
i = 4
def foo(x: Iterable[int]):
    def bar():
        print(i, end='')
    # 中间省略了若干语句，用来表明后面的 for 才把名字 i 绑成 foo 的局部变量。
    for i in x:  # 循环把 i 赋给了 foo 的局部变量，bar 读到的是这个局部绑定，而不是外层的 i。
        print(i, end='')
    bar()

```

因此 `foo([1, 2, 3])` 会打印 `1 2 3 3`，而不是 `1 2 3 4`。

#### 2.16.4 决定

可以使用。

### 2.17 函数与方法装饰器

有明显好处时审慎使用装饰器。避免 `staticmethod`，并限制 `classmethod` 的使用。

#### 2.17.1 定义

函数与方法的装饰器（也就是 “`@` 记号”）。一个常见装饰器是 `@property`，用于把普通方法转换成动态计算的属性。装饰器语法也允许用户自定义装饰器。具体来说，对某个函数 `my_decorator`，下面这样：

```
class C:
    @my_decorator
    def method(self):
        # 方法体在此省略，这个示例只关心装饰器写在 def 的上方，而不是装饰之后再赋回。

```

等价于：

```
class C:
    def method(self):
        # 方法体在此省略，这个示例只关心装饰器写在 def 的上方，而不是装饰之后再赋回。
    method = my_decorator(method)

```

#### 2.17.2 优点

优雅地标明对方法的某种变换；这种变换可以去掉一些重复代码、维持不变量等。

#### 2.17.3 缺点

装饰器可以对函数的参数或返回值做任意操作，从而产生令人意外的隐式行为。此外，装饰器在对象定义时执行。对模块级对象（类、模块函数等）来说，这发生在导入时。装饰器代码里的失败几乎无法恢复。

#### 2.17.4 决定

有明显好处时审慎使用装饰器。装饰器应遵循与函数相同的导入和命名准则。装饰器的文档字符串应明确说明该函数是装饰器。为装饰器编写单元测试。

装饰器自身应避免外部依赖（例如不要依赖文件、套接字、数据库连接等），因为装饰器运行时这些东西可能还不可用（可能在导入时，也许来自 `pydoc` 或其他工具）。用有效参数调用的装饰器应当（尽可能）在所有情况下都保证成功。

装饰器是“顶层代码”的一种特殊情况，更多讨论见 main。

除非为了接入现有库所定义的 API 而被迫使用，否则绝不要使用 `staticmethod`。应改写模块级函数。

只有在编写具名构造器，或编写会修改必要全局状态（例如进程范围的缓存）的类专用例程时，才使用 `classmethod`。

### 2.18 线程

不要依赖内置类型的原子性。

虽然 Python 的字典等内置数据类型看起来具有原子操作，但仍有并不原子的边角情况（例如 `__hash__` 或 `__eq__` 用 Python 方法实现时），不应依赖它们的原子性。也不应依赖变量赋值的原子性（因为这又依赖于字典）。

线程之间传递数据时，优先使用 `queue` 模块的 `Queue` 数据类型。否则使用 `threading` 模块及其锁原语。优先使用条件变量和 `threading.Condition`，而不是更底层的锁。

### 2.19 高级特性

避免这些特性。

#### 2.19.1 定义

Python 极其灵活，提供许多花哨特性，例如自定义元类、访问字节码、即时编译、动态继承、对象重新指定父类、导入技巧、反射（例如 `getattr()` 的某些用法）、修改系统内部、用 `__del__` 方法实现定制清理等。

#### 2.19.2 优点

这些是强大的语言特性。它们可以让代码更紧凑。

#### 2.19.3 缺点

在并非绝对必要的时候使用这些“酷”特性很有诱惑力。底层使用不寻常特性的代码更难读、更难理解和调试。起初（对原作者来说）似乎并非如此，但回看代码时，它往往比更长但直白的代码更难。

#### 2.19.4 决定

在代码里避免这些特性。

标准库里内部使用这些特性的模块和类可以使用（例如 `abc.ABCMeta`、`dataclasses` 和 `enum`）。

### 2.20 现代 Python：from __future__ 导入

新语言版本的语义变化可能被放在特殊的 future 导入后面，以便在更早的运行时里按文件启用。

#### 2.20.1 定义

通过 `from __future__ import` 语句打开一些更现代的特性，可以提前使用预期未来 Python 版本中的特性。

#### 2.20.2 优点

这已被证明能让运行时版本升级更平滑，因为可以按文件作出改动，同时声明兼容性，并防止这些文件里出现回退。现代代码更易维护，因为它更不容易积累会在未来运行时升级中造成问题的技术债。

#### 2.20.3 缺点

这类代码可能无法在引入所需 future 语句之前的非常老的解释器版本上运行。支持极其多样环境的项目更常有这种需要。

#### 2.20.4 决定

##### from __future__ 导入

鼓励使用 `from __future__ import` 语句。它让给定源文件从今天起就能使用更现代的 Python 语法特性。一旦不再需要在这些特性仍被 `__future__` 导入藏起来的版本上运行，就可以去掉那些行。

在可能运行于旧至 3.5、而不是 >= 3.7 的代码里，导入：

```
from __future__ import generator_stop

```

更多信息请阅读 Python future 语句定义文档。

在确信代码只会在足够现代的环境里使用之前，请不要去掉这些导入。即使你今天的代码还没用到某个 future 导入所启用的特性，把它留在文件里也可以防止以后修改代码时无意依赖旧行为。

其他 `from __future__` 导入语句可按需要使用。

### 2.21 带类型注解的代码

可以用类型提示给 Python 代码加注解。构建时用 pyrefly 这类类型检查工具检查代码。多数情况下，可行时应把类型注解写在源文件里。对第三方或扩展模块，注解可以放在存根 `.pyi` 文件里。

#### 2.21.1 定义

类型注解（或“类型提示”）用于函数或方法的参数和返回值：

```
def func(a: int) -> list[int]:

```

也可以用类似语法声明变量的类型：

```
a: SomeType = some_func()

```

#### 2.21.2 优点

类型注解提高代码的可读性和可维护性。类型检查器会把许多运行时错误变成构建时错误，并降低使用高级特性的能力。

#### 2.21.3 缺点

必须让类型声明保持最新。你可能看到一些自己认为代码有效的类型错误。使用类型检查器可能降低使用高级特性的能力。

#### 2.21.4 决定

强烈鼓励在更新代码时启用 Python 类型分析。添加或修改公共 API 时，加上类型注解，并在构建系统里启用类型检查。由于静态分析对 Python 来说相对较新，我们承认不受欢迎的副作用（例如错误推断的类型）可能让一些项目不愿采用。在那些情况下，鼓励作者加上带 TODO 的注释，或链接到描述当前阻碍采用类型注解的问题的缺陷，视情况写在 BUILD 文件或代码本身里。

## 3 Python 风格规则

### 3.1 分号

不要用分号结束一行，也不要用分号把两条语句放在同一行。

### 3.2 行宽

代码行最长 120 个字符。

注释行最多 120 个字符；注释正文超出后换行。注释块的第一行至少有 40 个字符的中文注释文字。

120 个字符代码行宽的明确例外：

- 很长的导入语句。
- 不含空白、拆开会不方便的长字符串模块级常量，例如 URL 或路径名。
- 注释里无法拆开的 URL 或机器指令（`# pylint: disable=invalid-name`、`# pyrefly: ignore[...]`、`# type:`）在拆行会改变语法时可以超过 120 个字符。该指令周围的中文正文仍然按 120 个字符换行。


不要用反斜杠做显式续行。

应利用 Python 在圆括号、方括号和花括号内的隐式续行。必要时可以在表达式外再加一对圆括号。

本规则并不禁止字符串内部用反斜杠转义的换行（见下文）。

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

字面字符串一行放不下时，用圆括号做隐式续行。

```
x = ('This will build a very long long '
     'long long long long long long string')

```

优先在尽可能高的语法层次断行。如果必须断两次，两次都在同一语法层次断开。

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

在注释里，必要时把长 URL 单独放在一行。

```
Yes:  # 字段的完整说明放在下一行的链接里，链接本身不要从中间折断，否则读者无法直接打开。
      # 规范链接单独占一行，读者和工具都能整段复制，不用把被折断的路径再拼回去，本例就是这样。
      # http://www.example.com/us/developer/documentation/api/content/v2.0/csv_file_name_extension_full_specification.html

```

```
No:  # 字段的完整说明放在下一行的链接里，链接本身不要从中间折断，否则读者无法直接打开。
     # 反例用反斜杠把链接拆成两行，读者无法直接打开，长链接应整段留在同一行里，本例就是这样。
     # http://www.example.com/us/developer/documentation/api/content/\
     # v2.0/csv_file_name_extension_full_specification.html

```

注意上面续行示例中各元素的缩进；解释见缩进一节。

文档字符串的摘要使用中文。第一行至少 40 个字符、至多 120 个字符。

在其他情况下，如果代码行超过 120 个字符，且格式化工具不能把它压到限制以内，该行可以超过这个上限。作者在合理时仍应按上面的规则断行。

### 3.3 圆括号

少用圆括号。

元组外面可以使用圆括号，但不是必须。除非为了隐式续行或为了标明元组，否则不要在 return 语句或条件语句里使用它们。

```
Yes: if foo:
         bar()
     while x:
         x = bar()
     if x and y:
         bar()
     if not x:
         bar()
     # 单元素元组靠括号比靠末尾逗号更容易看出来，读者不容易把它当成一个普通表达式，本例就是这样。
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

代码块使用 4 个空格缩进。

禁止使用 Tab。隐式续行应把换行后的元素垂直对齐（见行宽示例），或使用 4 个空格的悬挂缩进。闭合的圆括号、方括号或花括号可以放在表达式末尾，也可以单独成行，但那时应与对应开括号所在行缩进相同。

```
Yes:  # 续行与开括号之后的第一个参数对齐，读者能看出这些参数属于同一次函数调用，本例就是这样。
       foo = long_function_name(var_one, var_two,
                                var_three, var_four)
       meal = (spam,
               beans)

       # 字典的续行与开括号后的内容对齐，较长的键值表达式仍能看出属于同一个字面量，本例就是这样。
       foo = {
           'long_dictionary_key': value1 +
                                  value2,
           ...
       }

       # 第一行不放参数，换行后用四个空格悬挂缩进，闭括号可以跟在最后一项的后面，本例就是这样。
       foo = long_function_name(
           var_one, var_two, var_three,
           var_four)
       meal = (
           spam,
           beans)

       # 第一行不放参数，悬挂缩进四个空格，闭括号单独成行，并与开头的那一行对齐，本例就是这样。
       foo = long_function_name(
           var_one, var_two, var_three,
           var_four
       )
       meal = (
           spam,
           beans,
       )

       # 字典的值换到下一行时，相对键再悬挂缩进四个空格，不要和键挤在同一列里，本例就是这样。
       foo = {
           'long_dictionary_key':
               long_dictionary_value,
           ...
       }

```

```
No:  # 反例在第一行已经放了参数，续行却又改成悬挂缩进，两种对齐混在同一次调用里，本例就是这样。
       foo = long_function_name(var_one, var_two,
           var_three, var_four)
       meal = (spam,
           beans)

       # 反例只用两个空格做悬挂缩进，悬挂必须是四个空格，两格缩进不能出现在正例里，本例就是这样。
       foo = long_function_name(
         var_one, var_two, var_three,
         var_four)

       # 反例的字典值换行后没有再缩进，读者分不清这一行是值，还是下一个键，本例就是这样。
       foo = {
           'long_dictionary_key':
           long_dictionary_value,
           ...
       }

```

#### 3.4.1 项目序列中的尾随逗号？

只有当闭合容器记号 `]`、`)` 或 `}` 与最后一项不在同一行时，才建议在项目序列中使用尾随逗号；单元素元组也使用尾随逗号。尾随逗号的存在也会提示 Python 代码自动格式化工具 Black 或 Pyink：当最后一项后面有 `,` 时，把该容器格式化成每项一行。

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

顶层定义之间空两行，无论是函数定义还是类定义。方法定义之间空一行，`class` 的文档字符串与第一个方法之间也空一行。`def` 行后面不要空行。函数或方法内部按你认为合适的方式使用单行空行。

空行不必紧贴定义。例如，紧挨在函数、类和方法定义之前的相关注释可以是合理的。考虑这段注释放进文档字符串是否更有用。

### 3.6 空白

标点周围的空格遵循标准排版规则。

圆括号、方括号或花括号内部不要有空白。

```
Yes: spam(ham[1], {'eggs': 2}, [])

```

```
No:  spam( ham[ 1 ], { 'eggs': 2 }, [ ] )

```

逗号、分号或冒号之前不要有空白。逗号、分号或冒号之后要有空白，行尾除外。

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

开始参数列表、索引或切片的开括号之前不要有空白。

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

不要有行尾空白。

二元运算符两侧各留一个空格，用于赋值（`=`）、比较（`==, <, >, !=, <>, <=, >=, in, not in, is, is not`）和布尔运算（`and, or, not`）。算术运算符（`+`、`-`、`*`、`/`、`//`、`%`、`**`、`@`）周围是否插入空格，按你的判断决定。

```
Yes: x == 1

```

```
No:  x<1

```

传递关键字参数或定义默认参数值时，绝不要在 `=` 周围加空格，但有一个例外：存在类型注解时，默认参数值的 `=` 周围要加空格。

```
Yes: def complex(real, imag=0.0): return Magic(r=real, i=imag)
Yes: def complex(real, imag: float = 0.0): return Magic(r=real, i=imag)

```

```
No:  def complex(real, imag = 0.0): return Magic(r = real, i = imag)
No:  def complex(real, imag: float=0.0): return Magic(r = real, i = imag)

```

不要用空格把连续行上的记号垂直对齐，因为这会成为维护负担（适用于 `:`、`#`、`=` 等）：

```
Yes:
    foo = 1000  # 行尾注释说明这个赋值的含义，和代码之间只留两个空格，不要为了竖齐去垫空格，本例就是这样。
    long_name = 2  # 这条注释故意不和上一行的注释竖齐，竖齐会在改名时制造无关的空白差异，本例就是这样。

    dictionary = {
            'foo': 1,
            'long_name': 2,
    }

```

```
No:
    foo       = 1000  # 行尾注释说明这个赋值的含义，和代码之间只留两个空格，不要为了竖齐去垫空格，本例就是这样。
    long_name = 2  # 这条注释故意不和上一行的注释竖齐，竖齐会在改名时制造无关的空白差异，本例就是这样。

    dictionary = {
            'foo'      : 1,
            'long_name': 2,
    }

```

### 3.7 Shebang 行

大多数 `.py` 文件不需要以 `#!` 行开头。程序的主文件以 `#!/usr/bin/env python3`（以支持虚拟环境）或按 PEP-394 以 `#!/usr/bin/python3` 开头。

内核用这一行寻找 Python 解释器，但 Python 在导入模块时会忽略它。只有打算直接执行的文件才需要它。

### 3.8 注释与文档字符串

务必为模块、函数、方法的文档字符串和行内注释使用正确的风格。

#### 3.8.1 文档字符串

Python 用文档字符串记录代码。文档字符串是包、模块、类或函数中的第一条语句。这些字符串可以通过对象的 `__doc__` 成员自动提取，并供 `pydoc` 使用。（试着对自己的模块运行 `pydoc`，看看效果。）文档字符串始终使用三个双引号 `"""` 的格式（依据 PEP 257）。文档字符串摘要使用中文，作为一行物理行，至少 40 个字符、至多 120 个字符，并以 `。`、`？` 或 `！` 结尾。再写更多内容时（鼓励这样做），后面必须空一行，然后文档字符串的其余部分从第一行第一个引号所在的同一列开始。下面还有更多文档字符串格式准则。

#### 3.8.2 模块

每个文件都应包含许可证样板。为项目所用的许可证选择合适的样板（例如 Apache 2.0、BSD、LGPL、GPL）。

文件应以描述模块内容和用法的文档字符串开头。

```
"""用中文说明这个模块提供什么能力，以及调用方应该从哪里进入，不要只重复文件名，本例就是这样。

空一行之后再写整体行为。需要时补充导出的类、函数，并给出最短的调用示例。

    foo = ClassFoo()
    bar = foo.function_bar()
"""

```

##### 3.8.2.1 测试模块

测试模块不需要模块级文档字符串。`unittest.TestCase` 的子类不需要类文档字符串，`unittest.TestCase` 子类中的 `test_` 方法不需要方法文档字符串。只重复类名或方法名的文档字符串应当省略。

当文档字符串提供额外信息时应当写上，例如说明测试应如何运行，或解释不寻常的准备方式或外部依赖。

```
"""这个测试把黄金文件当作期望输出，失败时要对照那些文件，而不是只看断言文本，本例就是这样。

更新黄金文件需要显式带上 --update_golden_files，不要在普通运行里改写期望结果。
"""

```

不提供任何新信息的文档字符串不应当使用。

```
"""反例只重复了模块名 foo.bar，没有说明断言在保护哪一种行为，这种文档字符串应当删掉。
"""

```

或

```
    def test_foo_is_barred(self):
        """这个测试固定的是 bar 会作用到 foo 上，而不是只确认测试方法能被收集到。
        """

```

#### 3.8.3 函数与方法

在本节中，“函数”指方法、函数、生成器或属性。

具有下列任一性质的每个函数都必须有文档字符串：

- 属于公共 API
- 规模不小
- 逻辑并不显而易见

文档字符串应提供足够信息，使读者不必阅读函数代码就能写出调用。它应描述函数的调用语法和语义，但一般不描述实现细节，除非这些细节与函数如何被使用有关。例如，函数若把修改某个参数作为副作用，应在文档字符串里注明。否则，与调用方无关的、细微但重要的实现细节，最好写成代码旁边的注释，而不是写进函数的文档字符串。

文档字符串可以是描述式（`"""按调用方给出的键从 Bigtable 读取对应的数据行，调用方不必关心底层如何分片。"""`）或祈使式（`"""请按调用方给出的键从 Bigtable 读取对应数据行，不要把分片细节泄漏给调用方。"""`），但同一文件内风格应一致。`@property` 数据描述符的文档字符串应与属性使用同一风格（`"""这是当前已经打开的 Bigtable 表路径，调用方只能拿它去拼接后续读写请求。"""`），而不是“返回……”这种说法。

函数的某些方面应记录在下面列出的专门小节里。每一节以冒号结尾的标题行开始。除标题以外的所有内容应保持四个空格的悬挂缩进。如果函数的名字和签名已经足够说明，可以用一行文档字符串描述，这些小节可以省略。

Args:
: 按名字列出每个参数。说明应跟在名字后面，用冒号分隔，冒号后是空格或换行。如果说明太长，放不进一行 120 个字符的注释，就使用比参数名多 4 个空格的悬挂缩进。说明使用中文。如果代码里没有对应的类型注解，说明应包含所需类型。如果函数接受 `*foo`（可变长度参数列表）和/或 `**bar`（任意关键字参数），它们应列为 `*foo` 和 `**bar`。
Returns:（生成器则用 Yields:）
: 描述返回值的语义，包括类型注解没有提供的类型信息。如果函数只返回 None，不需要这一节。如果文档字符串以 “Return”、“Returns”、“Yield” 或 “Yields” 开头（例如 `"""Returns row from Bigtable as a tuple of strings."""`），并且开头一句足以描述返回值，也可以省略。不要模仿较旧的 “NumPy 风格”（示例），那种风格常常把元组返回值写成多个各自有名字的返回值（从不提及元组）。应把这种返回值描述为：“Returns: A tuple (mat_a, mat_b), where mat_a is …, and …”。文档字符串里的辅助名字不必对应函数体里使用的任何内部名字（那些不属于 API）。如果函数使用 `yield`（是生成器），`Yields:` 一节应记录 `next()` 返回的对象，而不是调用所求值得到的生成器对象本身。
Raises:
: 列出与接口相关的全部异常，并附上说明。使用与 Args: 中所述类似的“异常名 + 冒号 + 空格或换行以及悬挂缩进”风格。不应记录在违反文档字符串所规定的 API 时才会抛出的异常（因为那会自相矛盾地把违反 API 时的行为变成 API 的一部分）。

```
def fetch_smalltable_rows(
    table_handle: smalltable.Table,
    keys: Sequence[bytes | str],
    require_all_keys: bool = False,
) -> Mapping[bytes, tuple[str, ...]]:
    """按调用方给出的键从 Smalltable 读取行，字符串键会先按 UTF-8 编码。

    table_handle 必须是已经打开的表。缺行时是否失败由 require_all_keys 决定。

    Args:
        table_handle: 已经打开的 smalltable.Table，函数不会替调用方建连。
        keys: 要读取的键。字符串会先编码成 UTF-8，再向表查询。
        require_all_keys: 为真时，只要有一个键没有值就整批不返回。
    Returns:
        键到行的映射。每一行是字符串元组，返回的键始终是 bytes。
        某个键不在字典里，表示该行不存在，且 require_all_keys 当时为假。
    Raises:
        IOError: 访问 Smalltable 时发生了输入输出错误。
    """

```

同样，`Args:` 的这种换行变体也是允许的：

```
def fetch_smalltable_rows(
    table_handle: smalltable.Table,
    keys: Sequence[bytes | str],
    require_all_keys: bool = False,
) -> Mapping[bytes, tuple[str, ...]]:
    """按调用方给出的键从 Smalltable 读取行，字符串键会先按 UTF-8 编码。

    参数名单独成行时，说明从下一行开始，并再悬挂缩进四个空格。

    Args:
        table_handle:
            已经打开的 smalltable.Table，函数不会替调用方建连。
        keys:
            要读取的键。字符串会先编码成 UTF-8，再向表查询。
        require_all_keys:
            为真时，只要有一个键没有值就整批不返回。
    Returns:
        键到行的映射。每一行是字符串元组，返回的键始终是 bytes。
        某个键不在字典里，表示该行不存在，且 require_all_keys 当时为假。
    Raises:
        IOError: 访问 Smalltable 时发生了输入输出错误。
    """

```

被装饰函数的文档字符串必须说明装饰器作用之后的函数行为，因为那才是调用方会观察到的行为。

```
@contextlib.contextmanager
def read_from_remote_filesystem(url: str) -> Iterator[RemoteFile]:
    """打开远程文件供读取，退出 with 时由上下文管理器关闭该文件，调用方不必再手动关。

    装饰器改变了调用方看到的行为，文档必须描述装饰之后的结果。

    Args:
        url: 远程文件的地址，调用方要保证它在打开期间有效。
    Returns:
        上下文管理器，进入 with 后得到远程文件的读取句柄。
    """
    reader = remote_file_reader(url)
    try:
        yield reader
    finally:
        reader.close()

```

##### 3.8.3.1 被覆盖的方法

覆盖基类方法的方法，如果明确标了 `@override`，就不需要文档字符串，除非覆盖方法的行为实质收紧了基类契约，或需要提供细节（例如记录额外副作用）。那时，覆盖方法上必须有至少说明这些差异的文档字符串。

```
from typing import override

class Parent:
    def do_something(self):
        """父类方法的契约写在这里。子类若只是原样继承，就不必再抄一遍同一段说明文字，本例就是这样。
        """

# 子类方法标了 override，行为没有收紧父类契约，因此不再重复父类的文档字符串。
class Child(Parent):
    @override
    def do_something(self):
        pass

```

```
# 子类覆盖了方法却没有写 override，读者无法从装饰器跳回父类文档，这时必须自己写文档字符串。
class Child(Parent):
    def do_something(self):
        pass

# 只写“见父类”并没有补充契约，标了 override 就够指向父类，这种空文档应当去掉。
class Child(Parent):
    @override
    def do_something(self):
        """反例只让读者去看父类，没有写出这个覆盖方法自己改变了什么，标了 override 时不必留这句。
        """

```

#### 3.8.4 类

类应在类定义下方有描述该类的文档字符串。除属性以外的公共属性应记录在这里的 `Attributes` 一节，并遵循与函数 `Args` 一节相同的格式。

```
class SampleClass:
    """这个实例记录一份早餐偏好，以及按该偏好累计下来的鸡蛋数量，供后面的方法读取，本例就是这样。

    公共属性写在 Attributes 里，属性访问器不要重复列在这里。

    Attributes:
        likes_spam: 为真表示这个实例接受 SPAM，为假表示不接受。
        eggs: 已经累计的鸡蛋个数，从零开始，由实例自己更新。
    """

    def __init__(self, likes_spam: bool = False):
        """按调用方给出的 SPAM 偏好初始化实例，并把鸡蛋计数设为零，偏好只在这里写入一次。

        Args:
            likes_spam: 为真时实例接受 SPAM，默认不接受。
        """
        self.likes_spam = likes_spam
        self.eggs = 0

    @property
    def butter_sticks(self) -> int:
        """当前还剩多少根黄油。这个数量由实例状态算出来，不是构造函数传入的另一个动作，本例就是这样。
        """

```

所有类文档字符串都应以一行摘要开始，说明类实例代表什么。这意味着 `Exception` 的子类也应描述该异常代表什么，而不是它可能在何种上下文中出现。类文档字符串不应重复不必要的信息，例如这个类是一个类。

```
# 正例把对象含义或具体类型参数写出来，读者不用从类名或 Any 里猜测调用方得到什么。
class CheeseShopAddress:
    """这是一家奶酪店的地址，调用方用它定位店铺，而不是用它描述地址这个类本身，本例就是这样。
    """

class OutOfCheeseError(Exception):
    """表示奶酪已经没有库存。异常对象携带的是这种耗尽状态，而不是抛出它的那一层调用，本例就是这样。
    """

```

```
# 反例没有把对象含义或类型参数写清楚，读者只能看到名字，或者看到退回 Any 的签名。
class CheeseShopAddress:
    """反例用“这个类描述了什么”开头，摘要应直接说实例代表奶酪店地址，不要重复类这个词。
    """

class OutOfCheeseError(Exception):
    """反例强调异常会在什么时候被抛出。摘要应说明它代表奶酪耗尽，而不是抛出时的场景，本例就是这样。
    """

```

如果类被装饰，其文档字符串必须说明装饰器作用之后的类行为。

#### 3.8.5 块注释与行内注释

注释的最后一处是代码里棘手的部分。如果下次代码评审你得解释它，现在就应该写注释。复杂操作在操作开始前用几行注释。不明显的地方在行尾写注释。

```
# 用加权字典估计 i 在数组中的位置：先按最大值和长度外推，再二分找到精确下标，本例就是这样。

if i & (i-1) == 0:  # 当 i 为 0 或 2 的幂时这个位运算为真，只看运算符看不出这是在判断 2 的幂。

```

为了便于阅读，这些注释应离代码至少 2 个空格，以注释字符 `#` 开始，然后在注释文字之前至少再留一个空格。

另一方面，绝不要复述代码。假定读代码的人比你更懂 Python（尽管不知道你想做什么）。

```
# 反例只是把循环再说一遍：走到 b 里的 i 时检查下一项是不是 i+1，没有说明为什么要这样配对。

```

#### 3.8.6 标点、拼写与语法

注意标点、拼写和语法；写得好的注释比写得差的更容易读。

注释应像叙述文字一样可读，使用恰当的大小写和标点。许多情况下，完整句子比句子片段更可读。更短的注释，例如代码行末尾的注释，有时可以不那么正式，但风格应保持一致。

代码评审者指出你该用分号的地方用了逗号，可能让人懊恼，但源代码保持高度清晰和可读非常重要。恰当的标点、拼写和语法有助于这个目标。

### 3.10 字符串

即使参数全都是字符串，也使用 f-string、`%` 运算符或 `format` 方法来格式化字符串。在字符串格式化方式之间按你的最佳判断选择。单次用 `+` 连接是可以的，但不要用 `+` 做格式化。

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

避免在循环里用 `+` 和 `+=` 运算符累积字符串。在某些条件下，用加法累积字符串会导致平方而不是线性的运行时间。虽然 CPython 上这类常见累积可能被优化，那只是实现细节。优化在何种条件下生效不容易预测，也可能改变。应把每个子串加入列表，循环结束后对列表做 `''.join`，或者把每个子串写入 `io.StringIO` 缓冲区。这些手法的摊销运行时间复杂度始终是线性的。

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

在一个文件内，字符串引号字符的选择要一致。选定 `'` 或 `"` 并坚持使用。为了避免反斜杠转义字符串内部的引号字符，可以在某个字符串上使用另一种引号。

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

多行字符串优先使用 `"""`，而不是 `'''`。项目可以选择对所有非文档字符串的多行字符串使用 `'''`，当且仅当普通字符串也使用 `'`。文档字符串无论如何都必须使用 `"""`。

多行字符串不随程序其余部分的缩进流动。如果需要避免把额外空格嵌进字符串，使用拼接的单行字符串，或使用带 `textwrap.dedent()` 的多行字符串来去掉每行开头的空格：

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

注意，这里使用反斜杠并不违反禁止显式续行的规定；此时反斜杠是在转义字符串字面量中的换行。

#### 3.10.1 日志

对于把带 %-占位符的模式字符串作为第一个参数的日志函数：始终用字符串字面量（不是 f-string！）作为第一个参数来调用它们，模式参数作为后续参数。有些日志实现会把未展开的模式字符串收集为可查询字段。这也避免了在没有任何日志器配置为输出该消息时仍花时间渲染它。

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

错误消息（例如 `ValueError` 这类异常上的消息字符串，或展示给用户的消息）应遵循三条准则：

1. 消息必须精确匹配实际的错误条件。
2. 插值片段必须始终能被清楚地认出是插值。
3. 它们应允许简单的自动处理（例如用 grep 检索）。

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
    if p < 0 or p > 1:  # 这个比较对 float('nan') 也是假，不能用它判断概率是否落在闭区间里。
        raise ValueError(f'Not a probability: {p=}')

    try:
        os.rmdir(workdir)
    except OSError:
        # 删除失败不一定是因为目录已经不存在，这条日志把原因说死了，排查的人会被带偏，本例就是这样。
        logging.warning('Directory already was deleted: %s', workdir)

    try:
        os.rmdir(workdir)
    except OSError:
        # 把路径插进句子中间后，workdir 若刚好叫 deleted，日志会读成“已删除的目录无法删除”，也不利于按固定短语检索。
        logging.warning('The %s directory could not be deleted.', workdir)

```

### 3.11 文件、套接字及类似的有状态资源

用完文件和套接字后明确关闭它们。这条规则自然延伸到内部使用套接字的可关闭资源，例如数据库连接，以及其他需要以类似方式关闭的资源。仅举几例，这也包括 mmap 映射、h5py 的 File 对象，以及 matplotlib.pyplot 的图形窗口。

不必要地让文件、套接字或其他这类有状态对象保持打开有许多坏处：

- 它们可能消耗有限的系统资源，例如文件描述符。处理大量这类对象的代码，如果使用后不及时归还给系统，可能不必要地耗尽这些资源。
- 保持文件打开可能阻止其他操作，例如移动或删除它们，或卸载文件系统。
- 在程序各处共享的文件和套接字，可能在逻辑上已经关闭之后仍被无意读取或写入。如果它们真的被关闭，再读或写就会抛出异常，从而更早暴露问题。

此外，虽然文件和套接字（以及一些行为类似的资源）在对象被析构时会自动关闭，把对象的生存期和资源状态绑在一起是不好的做法：

- 运行时何时真正调用 `__del__` 方法没有保证。不同的 Python 实现使用不同的内存管理技术，例如延迟垃圾回收，可能任意地、无限地延长对象的生存期。
- 对文件的意外引用，例如在全局变量或异常回溯里，可能让它比预期留得更久。

依赖终结器做具有可观察副作用的自动清理，在几十年里、在多种语言中被反复发现会导致重大问题（例如参见这篇关于 Java 的文章）。

管理文件和类似资源的首选方式是使用 `with` 语句：

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

在基于上下文的资源管理不可行的少数情况下，代码文档必须清楚说明资源生存期如何管理。

### 3.12 TODO 注释

对临时的、短期的，或够用但并不完美的代码，使用 `TODO` 注释。

`TODO` 注释以全大写的单词 `TODO` 开始，并在括号里放一个包含上下文的资源链接，最好是缺陷引用。缺陷引用更好，因为缺陷被跟踪，并且有后续评论。在这段上下文之后跟一个冒号和说明字符串。

目的是有一种一致的 `TODO` 格式，可以搜索到如何获得更多细节。

```
# TODO(example.com/12345): 调查这条路径上的 cpufreq 调节是否真能降低功耗，结论出来前不要把实验代码留在热路径。

```

旧风格，以前推荐，但新代码不鼓励使用：

```
# TODO: example.com/12345 - 反例把链接和说明拆开了，TODO 应把缺陷链接放在括号里再写要调查的 cpufreq 问题。

```

避免添加把个人或团队当作上下文的 TODO：

```
# TODO(username): 先补上缺陷编号，再用星号表示这里的重复次数，不要让后人猜这个 TODO 归谁跟踪。

```

如果你的 `TODO` 属于“在将来某个日期做某事”这种形式，务必要么包含非常具体的日期（“Fix by November 2009”），要么包含未来的代码维护者能理解的非常具体的事件（“Remove this code when all clients can handle XML responses.”）。用问题单跟踪这件事最理想。

### 3.13 导入的格式

导入应各占一行；`typing` 和 `collections.abc` 的导入是例外。

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

导入始终放在文件顶部，紧接在任何模块注释和文档字符串之后、模块全局变量和常量之前。导入应按从最通用到最不通用分组：

1. Python future 导入语句。例如：

```
from __future__ import annotations

```

关于这些的更多信息见上文。
2. Python 标准库导入。例如：

```
import sys

```
3. 第三方模块或包导入。例如：

```
import tensorflow as tf

```
4. 代码仓库子包导入。例如：

```
from otherproject.ai import mind

```
5. 已废弃：与本文件属于同一个顶层子包的应用程序专用导入。例如：

```
from myproject.backend.hgwells import time_machine

```

你可能看到较旧的 Google Python 风格代码这样做，但现在不再要求。鼓励新代码不必再费这个心。只需把应用程序专用的子包导入和其他子包导入同样对待。

在每个分组内，导入应按每个模块的完整包路径（`from path import ...` 中的 `path`）忽略大小写进行字典序排序。代码可以可选地在导入各节之间放一个空行。

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

# 旧代码有时把同包导入留在函数里，新代码不要再这样分组，下面两行只展示那种过时写法。
#from myproject.backend.hgwells import time_machine
#from myproject.backend.state_machine import main_loop

```

### 3.14 语句

一般每行只有一条语句。

不过，只有当整条语句能放在一行时，才可以把测试的结果和测试放在同一行。特别是，`try`/`except` 绝不能这样做，因为 `try` 和 `except` 不能同时放在同一行；只有在没有 `else` 时，`if` 才可以这样做。

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

### 3.15 读取器与设置器

当读取器函数和设置器函数（也称为访问器和修改器）为获取或设置变量的值提供有意义的角色或行为时，才应使用它们。

特别是，当获取或设置该变量很复杂，或者代价很大（无论是现在还是在合理的将来）时，应当使用它们。

例如，如果一对读取器/设置器只是读写一个内部属性，就应把该内部属性公开。相比之下，如果设置一个变量意味着某些状态失效或需要重建，它就应当是设置器函数。函数调用暗示正在发生可能并不平凡的操作。当只需要简单逻辑时，属性也可以是一种选择，或者重构到不再需要读取器和设置器。

读取器和设置器应遵循命名准则，例如 `get_foo()` 和 `set_foo()`。

如果过去的行为允许通过属性访问，不要把新的读取器/设置器函数绑定到该属性上。任何仍试图用旧方式访问该变量的代码都应当明显地失败，从而让它们意识到复杂度已经改变。

### 3.16 命名

`module_name`、`package_name`、`ClassName`、`method_name`、`ExceptionName`、`function_name`、`GLOBAL_CONSTANT_NAME`、`global_var_name`、`instance_var_name`、`function_parameter_name`、`local_var_name`、`query_proper_noun_for_thing`、`send_acronym_via_https`。

名字应当具有描述性。这包括函数、类、变量、属性、文件以及任何其他类型的具名实体。

避免缩写。特别是，不要使用对项目外读者含糊或陌生的缩写，也不要通过删掉单词内部的字母来缩写。

始终使用 `.py` 文件扩展名。绝不要使用连字符。

#### 3.16.1 应当避免的名字

- 单字符名字，除了明确允许的情况：

- 计数器或迭代器（例如 `i`、`j`、`k`、`v` 等）
- `try/except` 语句中作为异常标识的 `e`
- `with` 语句中作为文件句柄的 `f`
- 没有约束的私有类型变量（例如 `_T = TypeVar("_T")`、`_P = ParamSpec("_P")`）
- 与参考文献或算法中既定记法一致的名字（见数学记法）

请注意不要滥用单字符命名。一般而言，描述性应与名字可见范围成比例。例如，`i` 对 5 行代码块可能是好名字，但在多层嵌套作用域里，它很可能太含糊。
- 任何包名或模块名中的连字符（`-`）
- `__double_leading_and_trailing_underscore__` 这种名字（由 Python 保留）
- 冒犯性词语
- 不必要地包含变量类型的名字（例如 `id_to_name_dict`）

#### 3.16.2 命名约定

- 一般遵循 PEP 8 的命名约定。
- “内部”指模块内部，或类中受保护或私有。
- 前置单个下划线（`_`）对保护模块变量和函数有一定支持（静态检查器会标记对受保护成员的访问）。注意，单元测试访问被测模块的受保护常量是可以的。
- 给实例变量或方法前置双下划线（`__`，也称 “dunder”）实际上会通过名字改写使该变量或方法对其类私有；我们不鼓励这种用法，因为它影响可读性和可测试性，而且并非真的私有。优先使用单个下划线。
- 把相关的类和顶层函数放在同一个模块里。与 Java 不同，不必把自己限制为每个模块一个类。
- 类名使用 CapWords，模块名使用 lower_with_under.py。虽然有一些旧模块名叫 CapWords.py，现在不鼓励这样做，因为当模块碰巧以某个类命名时会令人困惑。（“等等，我写的是 `import StringIO` 还是 `from StringIO import StringIO`？”）

- 注意 PEP 8 说：“在 CapWords 中使用首字母缩写时，缩写的所有字母都大写。因此 HTTPServerError 优于 HttpServerError。”
- 新的单元测试文件遵循符合 PEP 8 的 lower_with_under 方法名，例如 `test_<method_under_test>_ `。为了与遵循 CapWords 函数名的旧模块保持一致（*），以 `test` 开头的方法名中可以出现下划线，用来分隔名字的逻辑成分。一种可能的模式是 `test _ `。

##### 3.16.2.1 例外

下列例外适用于上面的一般命名约定：

- 当 Python 代码与外部或非 Python 代码库紧密耦合时，例如到 C++ 的外部函数接口（FFI），与另一代码库保持一致可能有理由遵循不同的约定（一致性）。

#### 3.16.3 文件命名

Python 文件名必须有 `.py` 扩展名，并且不得包含连字符（`-`）。这样它们才能被导入和做单元测试。如果希望可执行文件不带扩展名也能访问，使用符号链接，或一个包含 `exec "$0.py" "$@"` 的简单 bash 包装。

#### 3.16.4 源自 Guido 建议的准则

| 类型 | 公开 | 内部 |
| --- | --- | --- |
| 包 | `lower_with_under` | |
| 模块 | `lower_with_under` | `_lower_with_under` |
| 类 | `CapWords` | `_CapWords` |
| 异常 | `CapWords` | |
| 函数 | `lower_with_under()` | `_lower_with_under()` |
| 全局/类常量 | `CAPS_WITH_UNDER` | `_CAPS_WITH_UNDER` |
| 全局/类变量 | `lower_with_under` | `_lower_with_under` |
| 实例变量 | `lower_with_under` | `_lower_with_under`（受保护） |
| 方法名 | `lower_with_under()` | `_lower_with_under()`（受保护） |
| 函数/方法参数 | `lower_with_under` | |
| 局部变量 | `lower_with_under` | |

#### 3.16.5 数学记法

对数学含量很高的代码，如果短变量名与参考文献或算法中的既定记法一致，即使它们否则会违反风格指南，也优先使用。

使用基于既定记法的名字时：

1. 在注释或文档字符串里引用所有命名约定的来源，最好用超链接指向学术资料本身。如果来源无法访问，清楚记录这些命名约定。
2. 对公共 API 优先使用符合 PEP 8 的 `descriptive_names`，它们更可能在脱离上下文时被遇到。
3. 使用范围很窄的 `pylint: disable=invalid-name` 指令来消除警告。只有几个变量时，把指令作为每一处的行尾注释；更多时，在块的开头应用该指令。

### 3.17 主函数

在 Python 中，`pydoc` 以及单元测试都要求模块可以被导入。如果文件打算作为可执行文件使用，其主要功能应放在 `main()` 函数里，并且代码在执行主程序之前应始终检查 `if __name__ == '__main__'`，这样模块被导入时就不会执行它。

使用 absl 时，使用 `app.run`：

```
from absl import app
...

def main(argv: Sequence[str]):
    # 这里只处理旗标之外的位置参数，旗标解析要留在框架里，不要在 main 里再扫一遍 argv。
    ...

if __name__ == '__main__':
    app.run(main)

```

否则使用：

```
def main():
    ...

if __name__ == '__main__':
    main()

```

顶层的所有代码都会在模块被导入时执行。小心不要调用函数、创建对象，或执行在文件被 `pydoc` 时不应当执行的其他操作。

### 3.18 函数长度

优先使用小而专注的函数。

我们承认长函数有时是合适的，因此不对函数长度设置硬性限制。如果函数超过大约 40 行，想一想能否在不损害程序结构的情况下把它拆开。

即使你的长函数现在工作得很好，几个月后修改它的人可能加入新行为。这可能导致难以发现的缺陷。保持函数短小简单，能让其他人更容易阅读和修改你的代码。

处理某些代码时，你可能会遇到又长又复杂的函数。不要被修改现有代码吓住：如果使用这样的函数证明很困难，你发现错误难以调试，或者想在几个不同上下文中使用其中一段，考虑把函数拆成更小、更好管理的片段。

### 3.19 类型注解

#### 3.19.1 一般规则

- 熟悉类型提示。
- 一般不必给 `self` 或 `cls` 加注解。如果正确的类型信息需要它，可以使用 `Self`，例如

```
from typing import Self

class BaseClass:
    @classmethod
    def create(cls) -> Self:
        ...

    def difference(self, other: Self) -> float:
        ...

```
- 同样，不必勉强给 `__init__` 的返回值加注解（那里 `None` 是唯一有效选择）。
- 如果任何其他变量或返回类型不应当被表达，使用 `Any`。
- 不要求给模块里的所有函数加注解。

- 至少给公共 API 加注解。
- 用判断在一边的安全与清晰、另一边的灵活之间取得良好平衡。
- 给容易出现类型相关错误的代码加注解（以前的缺陷或复杂性）。
- 给难以理解的代码加注解。
- 当代码从类型角度看变得稳定时给它加注解。许多情况下，可以给成熟代码中的所有函数加注解，而不损失太多灵活性。

#### 3.19.2 断行

尽量遵循现有的缩进规则。

加注解之后，许多函数签名会变成“每个参数一行”。为了确保返回类型也独占一行，可以在最后一个参数后面放一个逗号。

```
def my_method(
        self,
        first_var: int,
        second_var: Foo,
        third_var: Bar | None,
) -> int:
    ...

```

始终优先在变量之间断开，而不是例如在变量名和类型注解之间断开。不过，如果所有内容都能放在同一行，就放在同一行。

```
def my_method(self, first_var: int) -> int:
    ...

```

如果函数名、最后一个参数和返回类型合在一起太长，在新行上缩进 4 个空格。使用断行时，优先把每个参数和返回类型各自放在一行，并使闭括号与 `def` 对齐：

```
Yes:
def my_method(
        self,
        other_arg: MyLongType | None,
) -> tuple[MyLongType1, MyLongType1]:
    ...

```

可选地，返回类型可以和最后一个参数放在同一行：

```
Okay:
def my_method(
        self,
        first_var: int,
        second_var: int) -> dict[OtherLongType, MyLongType]:
    ...

```

`pylint` 允许把闭括号移到新行并与开括号对齐，但这更难读。

```
No:
def my_method(self,
                            other_arg: MyLongType | None,
                          ) -> dict[OtherLongType, MyLongType]:
    ...

```

如上面的示例，优先不要把类型断开。不过有时它们太长，放不进一行（尽量保持子类型不断开）。

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

如果单个名字和类型太长，考虑为该类型使用别名。最后的办法是在冒号后断开并缩进 4 个空格。

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

如果需要使用（同一模块中）尚未定义的类名——例如需要在该类的声明内部使用类名，或使用在代码后面才定义的类——要么使用 `from __future__ import annotations`，要么用字符串表示类名。

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

依据 PEP-008，只有对同时具有类型注解和默认值的参数，才在 `=` 周围使用空格。

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

在 Python 类型系统中，`NoneType` 是“一等”类型，就类型标注而言，`None` 是 `NoneType` 的别名。如果参数可以是 `None`，就必须声明！可以使用 `|` 联合类型表达式（在新的 Python 3.10+ 代码中推荐），或较旧的 `Optional` 和 `Union` 语法。

使用显式的 `X | None`，不要使用隐式写法。较早版本的类型检查器允许把 `a: str = None` 解释为 `a: str | None = None`，但这不再是首选行为。

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

可以声明复杂类型的别名。

- 别名的名字应使用 CapWord。如果别名只在本模块使用，它应当是 _Private。
- 别名应类型注解为 `typing.TypeAlias`，以便与非类型的全局变量区分。
- 不要用类型别名代替不允许使用的 `from module import symbol` 惯用法。

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
# 模块内部可以用短别名减少行宽，但公共函数的签名里不要出现这个别名，调用方看不到它的定义。
_ShortName: TypeAlias = other_module.SignificantlyInconvenientlyLongName

```

#### 3.19.7 忽略类型

可以用特殊注释 `# type: ignore` 关闭一行上的类型检查。

`pyrefly` 有针对特定错误的关闭选项（与静态检查类似）：

```
# 这一行的属性访问是类型检查器的误报，只抑制 attribute-error，不要把整段函数的检查都关掉。
# pyrefly: ignore[attribute-error]

```

#### 3.19.8 给变量标注类型

带注解的赋值
: 如果内部变量的类型很难或不可能推断，用带注解的赋值标明它的类型——在变量名和值之间使用冒号和类型（与带默认值的函数参数相同）：

```
a: Foo = SomeUndecoratedFunction()

```
类型注释
: 虽然你可能看到它们仍留在代码库里（Python 3.6 之前它们是必要的），不要再新增行尾的 `# type: ` 注释：

```
# 这是旧式行尾类型注释，只保留给对照，新代码应把 Foo 写在变量注解里，不要再新增这种写法。
a = SomeUndecoratedFunction()  # type: Foo

```

#### 3.19.9 元组与列表

带类型的列表只能包含单一类型的对象。带类型的元组既可以有单一重复类型，也可以有固定数量、类型各不相同的元素。后者常用作函数的返回类型。

```
a: list[int] = [1, 2, 3]
b: tuple[int, ...] = (1, 2, 3)
c: tuple[int, str, float] = (1, "2", 3.5)

```

#### 3.19.10 类型变量

Python 类型系统有泛型。类型变量，例如 `TypeVar` 和 `ParamSpec`，是使用它们的常见方式。

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

`TypeVar` 可以被约束：

```
AddableType = TypeVar("AddableType", int, float, str)
def add(a: AddableType, b: AddableType) -> AddableType:
    return a + b

```

`typing` 模块中一个常见的预定义类型变量是 `AnyStr`。对多个可以是 `bytes` 或 `str`、并且必须全部是同一类型的注解，使用它。

```
from typing import AnyStr
def check_length(x: AnyStr) -> AnyStr:
    if len(x) <= 42:
        return x
    raise ValueError()

```

类型变量必须有描述性的名字，除非它满足下列全部条件：

- 外部不可见
- 没有被约束

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

> 不要在新代码中使用 `typing.Text`。它只用于 Python 2/3 兼容。

字符串/文本数据使用 `str`。处理二进制数据的代码使用 `bytes`。

```
def deals_with_text_data(x: str) -> str:
    ...
def deals_with_binary_data(x: bytes) -> bytes:
    ...

```

如果函数的所有字符串类型始终相同，例如上面代码中返回类型与参数类型相同，使用 AnyStr。

#### 3.19.12 为类型标注而导入

对来自 `typing` 或 `collections.abc` 模块、用于支持静态分析和类型检查的符号（包括类型、函数和常量），始终导入符号本身。这让常见注解更简洁，也符合世界各地的类型标注实践。明确允许从 `typing` 和 `collections.abc` 模块在一行上导入多个具体符号。例如：

```
from collections.abc import Mapping, Sequence
from typing import Any, Generic, cast, TYPE_CHECKING

```

由于这种导入方式会把名字加进局部命名空间，`typing` 或 `collections.abc` 中的名字应类似关键字对待，不要在你的 Python 代码里定义它们，无论是否带类型。如果类型与模块中已有名字冲突，使用 `import x as y` 导入它。

```
from typing import Any as AnyType

```

给函数签名加注解时，优先使用 `collections.abc.Sequence` 这类抽象容器类型，而不是 `list` 这类具体类型。如果需要使用具体类型（例如带类型元素的 `tuple`），优先使用 `tuple` 这类内置类型，而不是 `typing` 模块中的参数化类型别名（例如 `typing.Tuple`）。

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

只在例外情况下使用条件导入：类型检查所需的额外导入必须在运行时避免。不鼓励这种模式；应优先采用其他办法，例如重构代码以允许顶层导入。

只为类型注解所需的导入可以放在 `if TYPE_CHECKING:` 块里。

- 条件导入的类型在 Python 3.12 下需要以字符串引用，因为注解表达式在运行时会被求值。
- 这里只应定义仅用于类型标注的实体；这包括别名。否则会成为运行时错误，因为该模块在运行时不会被导入。
- 该块应紧接在所有普通导入之后。
- 类型导入列表中不应有空行。
- 把这个列表当作普通导入列表来排序。

```
import typing
if typing.TYPE_CHECKING:
    import sketch
def f(x: "sketch.Sketch"): ...

```

#### 3.19.14 循环依赖

由类型标注引起的循环依赖是代码异味。这类代码很适合重构。虽然技术上可以保留循环依赖，各种构建系统不会允许这样做，因为每个模块都必须依赖另一个。

用 `Any` 替换那些造成循环依赖导入的模块。用有意义的名字设置别名，并使用本模块中的真实类型名（`Any` 的任何属性都是 `Any`）。别名定义应与最后一条导入空开一行。

```
from typing import Any

some_mod = Any  # some_mod.py 会导入本模块，这里用字符串注解避开两个模块在导入时互相等待。
...

def my_method(self, var: "some_mod.SomeType") -> None:
    ...

```

#### 3.19.15 泛型

加注解时，优先在参数列表中为泛型类型指定类型参数；否则泛型的参数会被假定为 `Any`。

```
# 正例把对象含义或具体类型参数写出来，读者不用从类名或 Any 里猜测调用方得到什么。
def get_names(employee_ids: Sequence[int]) -> Mapping[int, str]:
    ...

```

```
# 反例没有写出类型参数，检查器会把它看成接收 Sequence[Any] 并返回 Mapping[Any, Any]。
def get_names(employee_ids: Sequence) -> Mapping:
    ...

```

如果泛型的最佳类型参数是 `Any`，就把它写明确，但记住许多情况下 `TypeVar` 可能更合适：

```
# 反例没有把对象含义或类型参数写清楚，读者只能看到名字，或者看到退回 Any 的签名。
def get_names(employee_ids: Sequence[Any]) -> Mapping[Any, str]:
    """按给定的员工编号返回编号到姓名的映射，编号的具体类型由调用方传入的序列决定，本例就是这样。
    """

```

```
# 正例把对象含义或具体类型参数写出来，读者不用从类名或 Any 里猜测调用方得到什么。
_T = TypeVar('_T')
def get_names(employee_ids: Sequence[_T]) -> Mapping[_T, str]:
    """按给定的员工编号返回编号到姓名的映射，编号的具体类型由调用方传入的序列决定，本例就是这样。
    """

```

## 4 结束语

保持一致。

如果你在修改代码，花几分钟看看周围的代码并确定它的风格。如果他们在索引变量名上使用 `_idx` 后缀，你也应当这样做。如果他们的注释周围有井号组成的小方框，你的注释也应当有井号组成的小方框。

风格指南的意义是拥有一套共同的编码词汇，使人们能把注意力放在你说什么上，而不是你怎么说。我们在这里给出全局风格规则，让人们知道这套词汇，但局部风格也很重要。如果你加进文件的代码与周围已有代码看起来截然不同，读者读到它时会被打乱节奏。

不过一致性有限度。它在局部、以及在全局风格未规定的选择上适用更重。一致性一般不应当被用作理由，去用旧风格做事，而不考虑新风格的好处，或代码库随时间趋向更新风格的倾向。
