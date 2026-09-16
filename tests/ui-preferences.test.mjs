import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {themePreference,resolvedTheme,readPreference,writePreference,themeBootstrap} from "../lib/ui-preferences.ts";
test("theme accepts only supported values and follows system preference",()=>{
  for(const value of [null,undefined,"unexpected","<script>",{}])assert.equal(themePreference(value),"system");
  assert.equal(resolvedTheme("system",true),"dark");assert.equal(resolvedTheme("system",false),"light");
  assert.equal(resolvedTheme("light",true),"light");assert.equal(resolvedTheme("dark",false),"dark");
});
test("restricted storage does not break preferences",()=>{
  const storage={getItem(){throw Error("blocked");},setItem(){throw Error("quota");}};
  assert.equal(readPreference(storage,"key"),null);assert.equal(writePreference(storage,"key","value"),false);
  assert.equal(writePreference({setItem(){}},"key","value"),true);
});
test("pre-paint script uses saved or system theme without evaluating stored data",()=>{
  for(const [saved,systemDark,expected]of [["dark",false,"dark"],["light",true,"light"],["system",true,"dark"],["malicious()",false,"light"]]){
    const document={documentElement:{dataset:{}}};
    vm.runInNewContext(themeBootstrap,{document,localStorage:{getItem:()=>saved},window:{matchMedia:()=>({matches:systemDark})}});
    assert.equal(document.documentElement.dataset.theme,expected);
  }
});
test("pre-paint script survives unavailable localStorage",()=>{
  const document={documentElement:{dataset:{}}};
  vm.runInNewContext(themeBootstrap,{document,get localStorage(){throw Error("blocked");},window:{matchMedia:()=>({matches:true})}});
  assert.equal(document.documentElement.dataset.theme,"dark");
});
