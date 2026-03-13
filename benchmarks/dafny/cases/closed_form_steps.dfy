method Steps(x: int) returns (y: int)
  requires 0 <= x
  decreases x
{
  if x == 0 {
    y := 1;
  } else {
    var r := Steps(x - 1);
    y := r + 1;
  }
}

method {:main} Main() {
  var result := 0;
  var i := 0;
  while i < 200000
    invariant 0 <= i <= 200000
  {
    result := Steps(400);
    i := i + 1;
  }
  print result, "\n";
}
