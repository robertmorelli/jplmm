method AvgFuel(guess: real, fuel: nat) returns (y: real)
  decreases fuel
{
  if fuel == 0 {
    y := guess;
  } else {
    var next := (guess + 100.0) / 2.0;
    y := AvgFuel(next, fuel - 1);
  }
}

method {:main} Main() {
  var result: real := 0.0;
  var i := 0;
  while i < 120000
    invariant 0 <= i <= 120000
  {
    result := AvgFuel(0.0, 64);
    i := i + 1;
  }
  print result, "\n";
}
