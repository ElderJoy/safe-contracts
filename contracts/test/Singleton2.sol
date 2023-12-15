// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity >=0.7.0 <0.9.0;

import {Singleton1} from "./Singleton1.sol";

/**
 * @title Singleton2 - A test contract that represents a target contract after upgrads
 */
contract Singleton2 is Singleton1 {
    uint256 public value;

    function setValue(uint256 _value) public {
        value = _value;
    }

    function getValue() public view returns (uint256) {
        return value;
    }
}