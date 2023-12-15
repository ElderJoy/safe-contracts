// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity >=0.7.0 <0.9.0;

/**
 * @title Singleton1 - A test contract that represents a target contract before upgrads
 */
contract Singleton1 {
    address _singleton;
    address public owner;
    bool public isInitialized;

    constructor() payable {
        owner = msg.sender;
    }

    function init(address new_owner) public {
        require(!isInitialized, "Is initialized");
        owner = new_owner;
        isInitialized = true;
    }

    function upgradeSingleton(address newImplementation) public {
        require(isInitialized, "Not initialized");
        require(msg.sender == owner, "Not owner");
        _singleton = newImplementation;
    }

    // To be clear, SafeProxy catch masterCopy() call and return _singleton address
    // so, this implementation is only used in direct call to Singleton1 contract
    function masterCopy() public pure returns (address) {
        return address(0);
    }

    // Makes call to another contract and return caller address
    function makeCallToGetCallerAddress(Singleton1 callee) public view returns (address) {
        return callee.getCallerAddress();
    }

    // Abstract implementation of getCallerAddress
    function makeCallToGetCallerAddress2(address callee) public view returns (address) {
        (bool success, bytes memory result) = callee.staticcall(abi.encodeWithSignature("getCallerAddress()"));
        require(success, "Failed to call");
        return abi.decode(result, (address));
    }

    function getCallerAddress() public view returns (address) {
        return msg.sender;
    }
}