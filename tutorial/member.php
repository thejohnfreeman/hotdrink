<?php

$model = <<<EOS
var model = { name: "James" };

$(document).ready(function () {
  hd.bind(model);
});
EOS;

$view = <<<EOS
Howdy, <span data-bind="text: \$this.name"></span>!
EOS;

include "template.php";

