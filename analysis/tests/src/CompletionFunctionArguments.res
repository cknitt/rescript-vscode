let someFn = (~isOn, ~isOff=false, ()) => {
  if isOn && !isOff {
    "on"
  } else {
    "off"
  }
}

let tLocalVar = false

// let _ = someFn(~isOn=)
//                      ^com

// let _ = someFn(~isOn=t)
//                       ^com

// let _ = someFn(~isOff=)
//                       ^com

let _ = someFn(
  ~isOn={
    // switch someFn(~isOn=)
    //                     ^com
    true
  },
)

let someOtherFn = (includeName, age, includeAge) => {
  "Hello" ++
  (includeName ? " Some Name" : "") ++
  ", you are age " ++
  Belt.Int.toString(includeAge ? age : 0)
}

// let _ = someOtherFn(f)
//                      ^com

module OIncludeMeInCompletions = {}

type someVariant = One | Two | Three(int, string)

let someFnTakingVariant = (
  configOpt: option<someVariant>,
  ~configOpt2=One,
  ~config: someVariant,
) => {
  ignore(config)
  ignore(configOpt)
  ignore(configOpt2)
}

// let _ = someFnTakingVariant(~config=)
//                                     ^com

// let _ = someFnTakingVariant(~config=O)
//                                      ^com

// let _ = someFnTakingVariant(S)
//                              ^com

// let _ = someFnTakingVariant(~configOpt2=O)
//                                          ^com

// let _ = someOtherFn()
//                     ^com

// let _ = someOtherFn(1, 2, )
//                          ^com

// let _ = 1->someOtherFn(1, t)
//                            ^com