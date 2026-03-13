// Dafny program aitken_avg.dfy compiled into Go
package main

import (
	m__System "System_"
	_dafny "dafny"
	os "os"
)

var _ = os.Args
var _ _dafny.Dummy__
var _ m__System.Dummy__

// Definition of class Default__
type Default__ struct {
	dummy byte
}

func New_Default___() *Default__ {
	_this := Default__{}

	return &_this
}

type CompanionStruct_Default___ struct {
}

var Companion_Default___ = CompanionStruct_Default___{}

func (_this *Default__) Equals(other *Default__) bool {
	return _this == other
}

func (_this *Default__) EqualsGeneric(x interface{}) bool {
	other, ok := x.(*Default__)
	return ok && _this.Equals(other)
}

func (*Default__) String() string {
	return "_module.Default__"
}
func (_this *Default__) ParentTraits_() []*_dafny.TraitID {
	return [](*_dafny.TraitID){}
}

var _ _dafny.TraitOffspring = &Default__{}

func (_static *CompanionStruct_Default___) AvgFuel(guess _dafny.Real, fuel _dafny.Int) _dafny.Real {
	goto TAIL_CALL_START
TAIL_CALL_START:
	var y _dafny.Real = _dafny.ZeroReal
	_ = y
	if (fuel).Sign() == 0 {
		y = guess
	} else {
		var _0_next _dafny.Real
		_ = _0_next
		_0_next = ((guess).Plus(_dafny.RealOfString("100"))).DivBy(_dafny.RealOfString("2"))
		var _in0 _dafny.Real = _0_next
		_ = _in0
		var _in1 _dafny.Int = (fuel).Minus(_dafny.One)
		_ = _in1
		guess = _in0
		fuel = _in1
		goto TAIL_CALL_START
	}
	return y
}
func (_static *CompanionStruct_Default___) Main(__noArgsParameter _dafny.Sequence) {
	var _0_result _dafny.Real
	_ = _0_result
	_0_result = _dafny.RealOfString("0")
	var _1_i _dafny.Int
	_ = _1_i
	_1_i = _dafny.Zero
	for (_1_i).Cmp(_dafny.IntOfInt64(120000)) < 0 {
		var _out0 _dafny.Real
		_ = _out0
		_out0 = Companion_Default___.AvgFuel(_dafny.RealOfString("0"), _dafny.IntOfInt64(64))
		_0_result = _out0
		_1_i = (_1_i).Plus(_dafny.One)
	}
	_dafny.Print(_0_result)
	_dafny.Print(_dafny.UnicodeSeqOfUtf8Bytes("\n").VerbatimString(false))
}

// End of class Default__
func main() {
	defer _dafny.CatchHalt()
	Companion_Default___.Main(_dafny.UnicodeFromMainArguments(os.Args))
}
