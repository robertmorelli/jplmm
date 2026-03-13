method Poly(x: int) returns (y: int) {
  y := x * x + 1;
}

method {:main} Main() {
  var result := 0;
  var i := 0;
  while i < 300000
    invariant 0 <= i <= 300000
  {
    result := Poly(15);
    i := i + 1;
  }
  print result, "\n";
}
