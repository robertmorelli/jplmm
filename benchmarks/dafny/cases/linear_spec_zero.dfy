method Zero(x: int) returns (y: int)
  requires 0 <= x
  decreases x
{
  if x == 0 {
    y := 0;
  } else {
    y := Zero(x - 1);
  }
}

method {:main} Main() {
  var result := 0;
  var i := 0;
  while i < 200000
    invariant 0 <= i <= 200000
  {
    result := Zero(400);
    i := i + 1;
  }
  print result, "\n";
}
