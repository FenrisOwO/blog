---
title: 夹具 Markdown
description: 带短代码、Mermaid、公式、代码块与图片的文章。
date: 2024-05-07
slug: fixture-markdown
toc: false
tags:
  - markdown
  - fixture
categories:
  - Fixture
---

正文里放上每一种特殊构造，body 编辑必须一个字节都不动它们。

{{< admonition tip >}}
一个 shortcode。
{{< /admonition >}}

```mermaid
graph TD;
  A-->B;
```

一段行间公式：

$$
a^2 + b^2 = c^2
$$

一段行内公式：\(x = 1\)。

代码块：

```js
const answer = 42;
```

一个列表：

- 第一项
- 第二项

一张图片：

![夹具图片](../fixture-bundle/fixture-photo.jpg)

<!--more-->

<div class="fixture-div">原生 HTML</div>
